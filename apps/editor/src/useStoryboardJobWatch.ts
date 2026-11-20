import { useCallback, useEffect, useRef, useState } from "react";
import { jobStartedReplay, jobWatchStep, type StoryboardJobPair, type StoryboardJobState } from "./storyboardModel";

/**
 * Follows the server's storyboard job from App, not from the panel.
 *
 * The panel used to be the only thing that polled `GET /api/storyboard/job`,
 * and it unmounts when it closes. An author who pressed Approve and closed
 * the panel therefore lost the job's end: the server saved the approval and
 * ran the sync run, the panel (reopened) said "in the video", and the
 * timeline kept the old production until a second Approve reloaded it
 * (author's real run, 2026-11-20, §169). The page that owns the timeline
 * has to own the hand-off to the render poll.
 *
 * `watch()` is called when a job was started (the panel's 202) and once per
 * project open, so a job that outlives a page reload is followed too. The
 * poll runs once a second and only while a job is being followed.
 */
export function useStoryboardJobWatch(onSyncStarted: () => void): {
  /** The running job, null when none: the Storyboard button's loader. */
  job: StoryboardJobState | null;
  watch: () => void;
} {
  const [job, setJob] = useState<StoryboardJobState | null>(null);
  const [polling, setPolling] = useState(false);
  // Whether a job's end is still owed a hand-off. A ref: the interval reads
  // it across renders.
  const armedRef = useRef(false);
  const onSyncRef = useRef(onSyncStarted);
  onSyncRef.current = onSyncStarted;

  const look = useCallback(async (): Promise<void> => {
    const res = await fetch("/api/storyboard/job");
    if (!res.ok) return;
    const pair = (await res.json()) as StoryboardJobPair;
    const step = jobWatchStep(armedRef.current, pair);
    armedRef.current = step.armed;
    setJob(pair.job);
    if (pair.job === null) setPolling(false);
    if (step.ended && jobStartedReplay(pair.last)) onSyncRef.current();
  }, []);

  /**
   * `started` says the caller saw the server accept a job: its end is owed a
   * hand-off even when it ends before the first look. Without it (a project
   * open) only a job seen running is followed, so an approve that ended
   * before the page loaded does not reload the production a second time.
   */
  const watchFrom = useCallback(
    (started: boolean) => {
      if (started) armedRef.current = true;
      setPolling(true);
      void look().catch(() => {
        // The poll asks again.
      });
    },
    [look],
  );

  useEffect(() => {
    if (!polling) return;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void look()
        .catch(() => {
          // The next tick asks again.
        })
        .finally(() => {
          inFlight = false;
        });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [polling, look]);

  // Once per page load: a job started before a reload is still running.
  useEffect(() => {
    watchFrom(false);
  }, [watchFrom]);

  const watch = useCallback(() => watchFrom(true), [watchFrom]);
  return { job, watch };
}
