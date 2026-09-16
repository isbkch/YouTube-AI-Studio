"""Trusted adapter for the locally installed Resolve 21.1 documented API.

Never evaluates instructions, shell commands, or scripts from a production plan.
Imports into a newly named project and refuses to modify an existing project.
"""
import json
import os
import sys


def main():
    import DaVinciResolveScript as dvr
    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        return {"available": False, "reason": "Resolve is closed, still starting, or local scripting is unavailable. Open Resolve and check Preferences > System > General > External scripting. The timeline files can also be imported manually."}
    result = {"available": True, "version": resolve.GetVersionString(), "product": resolve.GetProductName()}
    if sys.argv[1] == "probe":
        return result
    if sys.argv[1] != "import" or len(sys.argv) != 4:
        raise ValueError("Only probe and import actions are supported")
    file_path, project_name = sys.argv[2:]
    if not os.path.isfile(file_path) or os.path.splitext(file_path)[1] not in (".fcpxml", ".otio"):
        raise ValueError("Expected an existing FCPXML or OTIO file")
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


try:
    print("WTS_RESULT:" + json.dumps(main()))
except Exception as exc:
    print("WTS_RESULT:" + json.dumps({"available": False, "reason": str(exc)}))
    sys.exit(0)
