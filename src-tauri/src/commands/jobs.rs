//! Background jobs where only the latest request matters.
//!
//! The heavy "snapshot the target" work (the image-patch scan reads every
//! module's code out of the target) must not run on the session thread: that
//! thread serves every command of a paused session in order, so a second of
//! scanning is a second in which a step, a source lookup or a disassembly
//! request sits in the queue. Such work runs here instead, on its own thread
//! and its own connection.
//!
//! Requests for the same key are coalesced: while a job runs, a new request
//! cancels it and takes its place once it has stopped; a request that was
//! still waiting is simply replaced. However fast requests arrive, at most one
//! job per key is running and at most one is waiting, and the last one always
//! runs.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Told to a running job when a newer request has superseded it. A job checks
/// it between units of work and returns early without publishing a result.
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

type Job = Box<dyn FnOnce(&Cancel) + Send>;

#[derive(Default)]
struct Slot {
    /// The job in progress, if any.
    running: Option<Cancel>,
    /// The request to run once the job in progress has stopped.
    next: Option<Job>,
}

#[derive(Default)]
pub struct CoalescedJobs {
    slots: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
}

impl CoalescedJobs {
    /// Run `job` for `key` in the background, superseding whatever is running
    /// or waiting for that key.
    pub fn request(&self, key: &str, job: impl FnOnce(&Cancel) + Send + 'static) {
        let slot = self.slots.lock().unwrap().entry(key.to_string()).or_default().clone();
        let mut state = slot.lock().unwrap();
        if let Some(running) = &state.running {
            running.cancel();
            state.next = Some(Box::new(job));
            return;
        }
        let cancel = Cancel::default();
        state.running = Some(cancel.clone());
        drop(state);

        let mut job: Job = Box::new(job);
        let mut cancel = cancel;
        std::thread::spawn(move || loop {
            job(&cancel);
            let mut state = slot.lock().unwrap();
            match state.next.take() {
                Some(next) => {
                    job = next;
                    cancel = Cancel::default();
                    state.running = Some(cancel.clone());
                }
                None => {
                    state.running = None;
                    return;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(10);

    #[test]
    fn a_request_runs() {
        let jobs = CoalescedJobs::default();
        let (done, finished) = mpsc::channel();
        jobs.request("k", move |cancel| done.send(cancel.is_cancelled()).unwrap());
        assert_eq!(finished.recv_timeout(WAIT), Ok(false));
    }

    #[test]
    fn a_newer_request_cancels_the_running_job_and_only_the_last_one_waiting_runs() {
        let jobs = CoalescedJobs::default();
        let (events, log) = mpsc::channel::<&'static str>();
        let (started, first_started) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();

        let first = events.clone();
        jobs.request("k", move |cancel| {
            started.send(()).unwrap();
            released.recv_timeout(WAIT).unwrap();
            first.send(if cancel.is_cancelled() { "first: cancelled" } else { "first: finished" }).unwrap();
        });
        first_started.recv_timeout(WAIT).unwrap();

        // Two more arrive while the first is still running.
        let second = events.clone();
        jobs.request("k", move |_| second.send("second").unwrap());
        let third = events.clone();
        jobs.request("k", move |cancel| third.send(if cancel.is_cancelled() { "third: cancelled" } else { "third" }).unwrap());
        release.send(()).unwrap();

        assert_eq!(log.recv_timeout(WAIT), Ok("first: cancelled"));
        assert_eq!(log.recv_timeout(WAIT), Ok("third"));
        // The second was replaced before it ever ran.
        drop(events);
        assert!(log.recv_timeout(WAIT).is_err());
    }

    #[test]
    fn keys_do_not_wait_for_each_other() {
        let jobs = CoalescedJobs::default();
        let (release, released) = mpsc::channel::<()>();
        let (done, finished) = mpsc::channel();
        jobs.request("slow", move |_| {
            let _ = released.recv_timeout(WAIT);
        });
        jobs.request("fast", move |_| done.send(()).unwrap());
        assert_eq!(finished.recv_timeout(WAIT), Ok(()));
        release.send(()).unwrap();
    }

    #[test]
    fn the_key_is_free_again_after_its_job() {
        let jobs = CoalescedJobs::default();
        for round in 0..3 {
            let (done, finished) = mpsc::channel();
            jobs.request("k", move |cancel| done.send(cancel.is_cancelled()).unwrap());
            assert_eq!(finished.recv_timeout(WAIT), Ok(false), "round {round}");
            // Let the worker thread retire the slot before the next request.
            while jobs.slots.lock().unwrap()["k"].lock().unwrap().running.is_some() {
                std::thread::yield_now();
            }
        }
    }
}
