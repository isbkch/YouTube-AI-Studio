"""Trusted adapter for locally installed Blender: stylized 3D B-roll clips.

Never evaluates instructions, scripts or prose from a production plan. The
scene spec is schema-validated in TypeScript before this bridge runs; every
field here is re-checked with plain assertions. Renders with EEVEE headless.
"""
import json
import math
import os
import sys


def need(condition, message):
    if not condition:
        raise ValueError("Invalid scene spec: %s" % message)


def color(hex_value):
    need(isinstance(hex_value, str) and len(hex_value) == 7 and hex_value[0] == "#",
         "colors must be #rrggbb")
    return tuple(int(hex_value[i:i + 2], 16) / 255.0 for i in (1, 3, 5)) + (1.0,)


def clear_scene(scene):
    for obj in list(scene.objects):
        scene.collection.objects.unlink(obj)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def material(name, rgba, emit=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Emission Color"].default_value = rgba
    bsdf.inputs["Emission Strength"].default_value = emit
    return mat


def add_light(scene, rgba, energy, location):
    light = bpy.data.lights.new("Key", type="AREA")
    light.energy = energy
    light.color = rgba[:3]
    light.size = 12
    obj = bpy.data.objects.new("Key", light)
    obj.location = location
    obj.rotation_euler = (math.radians(45), 0, math.radians(30))
    scene.collection.objects.link(obj)


def add_camera(scene, location, rotation):
    camera = bpy.data.cameras.new("Camera")
    obj = bpy.data.objects.new("Camera", camera)
    obj.location = location
    obj.rotation_euler = rotation
    scene.collection.objects.link(obj)
    scene.camera = obj
    return obj


def box(name, size, location, mat, scene):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size, size, size)
    obj.data.materials.append(mat)
    return obj


def pulse(material_obj, high, frames, period, offset):
    """Keyframe emission strength so the material blinks at the given rate."""
    strength = material_obj.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"]
    for f in range(1, frames + 2, period):
        strength.default_value = high if ((f + offset) // period) % 2 == 0 else 0.4
        strength.keyframe_insert("default_value", frame=f)


# --- Templates -------------------------------------------------------------
# Each builder receives (scene, spec, palette) and must set up geometry,
# camera, lights and animation for exactly spec["durationFrames"] frames.

def build_network_flow(scene, spec, pal):
    nodes = spec["parameters"]["nodes"]
    packets = spec["parameters"]["packets"]
    frames = spec["durationFrames"]
    positions = []
    for i, label in enumerate(nodes):
        angle = 2 * math.pi * i / len(nodes)
        x, y = 4.2 * math.cos(angle), 4.2 * math.sin(angle)
        node = box("node-%d" % i, 1.1, (x, y, 0), material("node", pal["accent"], 0.25), scene)
        node.rotation_euler = (0, 0, angle)
        positions.append((x, y))
    add_camera(scene, (0, -2, 11), (0, 0, 0))
    add_light(scene, pal["foreground"], 3000, (4, -6, 8))
    for p in range(packets):
        start, end = positions[p % len(positions)], positions[(p + 1) % len(positions)]
        offset = frames * p / packets
        cube = box("packet-%d" % p, 0.32, start, material("packet", pal["accent"], 4.0), scene)
        cube.location = (start[0], start[1], 0)
        cube.keyframe_insert(data_path="location", frame=1 + offset % frames)
        cube.location = (end[0], end[1], 0)
        cube.keyframe_insert(data_path="location", frame=(offset + frames / packets) % frames + 1)


def build_server_rack(scene, spec, pal):
    racks, rate = spec["parameters"]["racks"], spec["parameters"]["pulseRate"]
    frames = spec["durationFrames"]
    floor = box("floor", 1, (0, -6, -0.5), material("floor", pal["background"]), scene)
    floor.scale = (40, 40, 0.2)
    period = max(1, int(spec["frameRate"] / rate))
    for r in range(racks):
        x = (r - (racks - 1) / 2) * 2.4
        rack = box("rack-%d" % r, 1, (x, 2, 2), material("rack", pal["foreground"]), scene)
        rack.scale = (1.6, 1.2, 4.2)
        for u in range(6):
            led_mat = material("led", pal["accent"], 8.0)
            box("led-%d-%d" % (r, u), 0.14, (x, 1.2, 0.4 + u * 1.3), led_mat, scene)
            pulse(led_mat, 8.0, frames, period, 3 * (r + u))
    add_camera(scene, (0, -9, 3.2), (math.radians(78), 0, 0))
    add_light(scene, pal["accent"], 1500, (0, -4, 7))


def build_orbit_rings(scene, spec, pal):
    rings, revolutions = spec["parameters"]["rings"], spec["parameters"]["revolutions"]
    frames = spec["durationFrames"]
    core = box("core", 1.4, (0, 0, 0), material("core", pal["foreground"], 0.4), scene)
    for r in range(rings):
        ring = box("ring-%d" % r, 1, (0, 0, 0), material("ring", pal["accent"], 2.0), scene)
        ring.scale = (5.2 + r * 1.3, 0.16, 0.16)
        ring.location.z = -1 + r * 0.7
        ring.keyframe_insert(data_path="rotation_euler", frame=1)
        ring.rotation_euler = (0, 0, 2 * math.pi * revolutions)
        ring.keyframe_insert(data_path="rotation_euler", frame=frames + 1)
    add_camera(scene, (7.5, -7.5, 5), (math.radians(65), 0, math.radians(45)))
    add_light(scene, pal["foreground"], 2500, (5, -8, 9))


def build_cascade_grid(scene, spec, pal):
    columns, rows, waves = spec["parameters"]["columns"], spec["parameters"]["rows"], spec["parameters"]["waves"]
    frames = spec["durationFrames"]
    base = material("cube", pal["accent"], 0.15)
    for c in range(columns):
        for r in range(rows):
            cube = box("cube-%d-%d" % (c, r), 0.8, (c - columns / 2, r - rows / 2, 0), base, scene)
            phase = 2 * math.pi * waves * ((c + r) / (columns + rows))
            cube.location.z = 0
            cube.keyframe_insert(data_path="location", frame=1)
            cube.location.z = 1.6 * math.sin(phase)
            cube.keyframe_insert(data_path="location", frame=frames + 1)
    add_camera(scene, (0, -columns * 1.1, columns * 0.8), (math.radians(55), 0, 0))
    add_light(scene, pal["foreground"], 3000, (6, -8, 10))


def build_data_tunnel(scene, spec, pal):
    segments, speed = spec["parameters"]["segments"], spec["parameters"]["speed"]
    frames = spec["durationFrames"]
    travel = speed * frames / spec["frameRate"]
    slab_mat = material("slab", pal["accent"], 1.5)
    frame_mat = material("frame", pal["foreground"], 0.3)
    for s in range(segments):
        z = -s * 2.0
        ring = box("slab-%d" % s, 1, (0, 0, z), slab_mat if s % 3 == 0 else frame_mat, scene)
        ring.scale = (4.4, 4.4, 0.12)
    camera = add_camera(scene, (0, 0, 2), (0, 0, 0))
    camera.keyframe_insert(data_path="location", frame=1)
    camera.location = (0, 0, 2 - travel * 2.0)
    camera.keyframe_insert(data_path="location", frame=frames + 1)
    add_light(scene, pal["foreground"], 800, (0, -3, 2))


def build_terrain_sweep(scene, spec, pal):
    import random
    import zlib
    ridges, amplitude = spec["parameters"]["ridges"], spec["parameters"]["amplitude"]
    frames = spec["durationFrames"]
    # Stable seed: Python's hash() is salted per process, crc32 is not.
    seed = zlib.crc32(json.dumps(spec["parameters"], sort_keys=True).encode())
    rng = random.Random(seed)
    mesh = bpy.data.meshes.new("terrain")
    verts, faces = [], []
    n = 48
    for i in range(n):
        for j in range(n):
            verts.append((i - n / 2, j - n / 2,
                          amplitude * 8 * (rng.random() * (0.4 if (i + j) % ridges else 1.0))))
    for i in range(n - 1):
        for j in range(n - 1):
            a = i * n + j
            faces.append((a, a + 1, a + n + 1, a + n))
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new("terrain", mesh)
    obj.data.materials.append(material("terrain", pal["accent"], 0.1))
    scene.collection.objects.link(obj)
    camera = add_camera(scene, (-14, -14, 9), (math.radians(58), 0, math.radians(40)))
    camera.keyframe_insert(data_path="location", frame=1)
    camera.location = (14, -6, 7)
    camera.keyframe_insert(data_path="location", frame=frames + 1)
    add_light(scene, pal["foreground"], 4000, (0, -10, 14))


BUILDERS = {
    "NetworkFlow": build_network_flow,
    "ServerRack": build_server_rack,
    "OrbitRings": build_orbit_rings,
    "CascadeGrid": build_cascade_grid,
    "DataTunnel": build_data_tunnel,
    "TerrainSweep": build_terrain_sweep,
}


def main():
    global bpy
    import bpy
    argv = sys.argv
    marker = argv.index("--") if "--" in argv else len(argv)
    args = argv[marker + 1:]
    if len(args) != 1:
        raise ValueError("Expected exactly one spec.json path after --")
    spec_path = args[0]
    if not os.path.isfile(spec_path) or os.path.splitext(spec_path)[1] != ".json":
        raise ValueError("Expected an existing spec.json file")
    with open(spec_path) as handle:
        spec = json.load(handle)
    template = spec.get("template")
    need(template in BUILDERS, "unknown template %r" % template)
    frames_dir = spec.get("framesDir")
    need(isinstance(frames_dir, str) and os.path.isabs(frames_dir),
         "framesDir must be an absolute directory path")
    width, height = spec.get("width"), spec.get("height")
    need((width, height) == (1920, 1080), "render resolution must be 1920x1080")
    frame_rate, frames = spec.get("frameRate"), spec.get("durationFrames")
    need(frame_rate in (24, 25, 30) and isinstance(frames, int) and 12 <= frames <= 324000,
         "invalid frame rate or duration")
    pal = {key: color(spec["brand"][key]) for key in ("background", "foreground", "accent")}

    # Start from an empty factory scene: the default startup scene carries
    # objects (Cube, Camera, Light) that interfere with primitive_add.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    # EEVEE was renamed across Blender versions; accept either identifier.
    engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items else "BLENDER_EEVEE"
    scene.render.engine = engine
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.fps = frame_rate
    # Movie containers differ across Blender versions; render a PNG sequence
    # and let TypeScript encode H.264 with the project's own ffmpeg path.
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.frame_start = 1
    scene.frame_end = frames
    os.makedirs(frames_dir, exist_ok=True)
    world = bpy.data.worlds.new("WTSWorld")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs[0].default_value = color(spec["brand"]["background"])
    background.inputs[1].default_value = 1.0
    scene.world = world
    BUILDERS[template](scene, spec, pal)
    scene.render.filepath = os.path.join(frames_dir, "frame_")
    bpy.ops.render.render(animation=True)
    rendered = len([
        name for name in os.listdir(frames_dir)
        if name.startswith("frame_") and name.endswith(".png")
    ])
    if rendered < frames:
        raise RuntimeError(
            "Blender rendered %d of %d frames" % (rendered, frames))
    return {"available": True, "template": template, "frames": rendered,
            "engine": engine, "framesDir": frames_dir}


try:
    print("WTS_RESULT:" + json.dumps(main()))
except Exception as exc:
    print("WTS_RESULT:" + json.dumps({"available": False, "reason": str(exc)}))
    sys.exit(0)
