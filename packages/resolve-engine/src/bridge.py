"""Trusted adapter for the locally installed Resolve 21.1 documented API.

Never evaluates instructions, shell commands, or scripts from a production plan.
Imports into a newly named project and refuses to modify an existing project.
"""
import json
import os
import sys
import time


def fresh_project(resolve, project_name):
    manager = resolve.GetProjectManager()
    previous = manager.GetCurrentProject()
    # Save the current project before switching; never overwrite a named project.
    if previous is not None and not manager.SaveProject():
        raise RuntimeError("Cannot save the current Resolve project before switching")
    if project_name in manager.GetProjectListInCurrentFolder():
        raise RuntimeError("A Resolve project with this name already exists. Use a new export name.")
    project = manager.CreateProject(project_name)
    if project is None:
        raise RuntimeError("Resolve could not create the project")
    return manager, project


def main():
    import DaVinciResolveScript as dvr
    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        return {"available": False, "reason": "Resolve is closed, still starting, or local scripting is unavailable. Open Resolve and check Preferences > System > General > External scripting. The timeline files can also be imported manually."}
    result = {"available": True, "version": resolve.GetVersionString(), "product": resolve.GetProductName()}
    if sys.argv[1] == "probe":
        return result
    if sys.argv[1] == "import":
        if len(sys.argv) != 4:
            raise ValueError("Only probe, import and render actions are supported")
        file_path, project_name = sys.argv[2:]
        if not os.path.isfile(file_path) or os.path.splitext(file_path)[1] not in (".fcpxml", ".otio"):
            raise ValueError("Expected an existing FCPXML or OTIO file")
        manager, project = fresh_project(resolve, project_name)
        project.SetSetting("timelineFrameRate", "30")
        project.SetSetting("timelineResolutionWidth", "1280")
        project.SetSetting("timelineResolutionHeight", "720")
        timeline = project.GetMediaPool().ImportTimelineFromFile(file_path, {"timelineName": project_name, "importSourceClips": True})
        if timeline is None:
            raise RuntimeError("Resolve did not accept the timeline. The newly created project was left for inspection.")
        project.SetCurrentTimeline(timeline)
        if not manager.SaveProject():
            raise RuntimeError("Imported timeline could not be saved")
        result.update(project=project.GetName(), timeline=timeline.GetName(), videoTracks=timeline.GetTrackCount("video"), audioTracks=timeline.GetTrackCount("audio"), startFrame=timeline.GetStartFrame(), endFrame=timeline.GetEndFrame())
        return result
    if sys.argv[1] != "render" or len(sys.argv) not in (6, 7):
        raise ValueError("Only probe, import and render actions are supported")
    file_path, project_name, output_path, preset = sys.argv[2:6]
    macro_path = sys.argv[6] if len(sys.argv) == 7 else None
    if not os.path.isfile(file_path) or os.path.splitext(file_path)[1] != ".fcpxml":
        raise ValueError("Final render requires the exported FCPXML timeline")
    if not os.path.isabs(output_path) or os.path.splitext(output_path)[1] not in (".mp4", ".mov"):
        raise ValueError("Final render output must be an absolute MP4/MOV path")
    if macro_path is not None and (not os.path.isfile(macro_path) or os.path.splitext(macro_path)[1] != ".setting"):
        raise ValueError("Fusion macro must be a checked-in .setting file")
    manager, project = fresh_project(resolve, project_name)
    timeline = project.GetMediaPool().ImportTimelineFromFile(file_path, {"timelineName": project_name, "importSourceClips": True})
    if timeline is None:
        raise RuntimeError("Resolve did not accept the timeline. The newly created project was left for inspection.")
    project.SetCurrentTimeline(timeline)
    if macro_path is not None:
        clips = timeline.GetItemListInTrack("video", 1) or []
        applied = 0
        for clip in clips:
            comp = None
            if hasattr(clip, "AddFusionCompByPath"):
                comp = clip.AddFusionCompByPath(macro_path)
            if comp is None and hasattr(clip, "LoadFusionCompByPath"):
                comp = clip.LoadFusionCompByPath(macro_path)
            if comp is None:
                raise RuntimeError("Resolve refused the Fusion macro on a clip; check the macro against this Resolve version")
            applied += 1
        result.update(fusionMacro=os.path.basename(macro_path), fusionApplied=applied)
    if not project.LoadRenderPreset(preset):
        raise RuntimeError("Render preset not found: %s" % preset)
    if not project.SetRenderSettings({"CustomName": os.path.splitext(os.path.basename(output_path))[0], "TargetDir": os.path.dirname(output_path)}):
        raise RuntimeError("Resolve rejected the render destination")
    job_id = project.AddRenderJob()
    if not job_id:
        raise RuntimeError("Resolve did not queue the render job")
    if not project.StartRendering([job_id]):
        raise RuntimeError("Resolve failed to start rendering")
    while project.IsRenderingInProgress():
        time.sleep(1)
    job = project.GetRenderJobStatus(job_id) or {}
    status = job.get("JobStatus", "Unknown")
    if status != "Complete":
        raise RuntimeError("Resolve render did not complete (status %s): %s" % (status, job.get("Error", "Check the Resolve render queue")))
    produced = next(
        (
            candidate
            for candidate in (
                output_path,
                os.path.splitext(output_path)[0] + ".mov",
                os.path.splitext(output_path)[0] + ".m4v",
            )
            if os.path.isfile(candidate)
        ),
        None,
    )
    result.update(project=project.GetName(), timeline=timeline.GetName(), renderJob=job_id, renderStatus=status, output=produced)
    return result


try:
    print("WTS_RESULT:" + json.dumps(main()))
except Exception as exc:
    print("WTS_RESULT:" + json.dumps({"available": False, "reason": str(exc)}))
    sys.exit(0)
