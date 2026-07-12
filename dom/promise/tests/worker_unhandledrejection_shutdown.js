Promise.reject("bug1642147_worker_shutdown_error");
postMessage("rejected");
self.close();
