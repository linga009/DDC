#pragma once

#include <string>
#include <vector>

namespace swarm {

// RAII wrapper for a detached child process, spawned directly via an argv
// array -- NEVER through a shell. This matters because argv values can
// originate from a network request body (the launcher's own use case,
// Phase B): going through a shell (as std::system() does) would let a
// value like a model name containing ";" or "&&" inject additional
// commands. CreateProcess on Windows and execvp on POSIX both take the
// process's arguments directly, with no shell interpretation of
// metacharacters -- only whitespace/quoting affects argument boundaries,
// never command chaining.
class SpawnedProcess {
public:
    // argv[0] is the executable (resolved via PATH if not an absolute
    // path, matching execvp's/CreateProcess's own behavior); argv[1..] are
    // its arguments. Throws std::runtime_error if argv is empty or if the
    // process could not be started at all (e.g. the executable doesn't
    // exist).
    explicit SpawnedProcess(const std::vector<std::string>& argv);
    ~SpawnedProcess();

    SpawnedProcess(const SpawnedProcess&) = delete;
    SpawnedProcess& operator=(const SpawnedProcess&) = delete;

    // Kills the process if it's still running. Idempotent: a second call,
    // or one after the process already exited on its own, is a no-op.
    // Waits briefly (bounded) for the OS to finish tearing the process
    // down, so a caller that immediately tries to reuse a port the
    // process was using doesn't race the teardown -- but never blocks
    // indefinitely.
    void terminate();

private:
    // Windows: HANDLE, stored as intptr_t so this header doesn't have to
    // include <windows.h> -- matches ResponseWriter::socketHandle_'s
    // existing rationale for the identical pattern. POSIX: pid_t, widened
    // to intptr_t for the same reason (one member works for both, no
    // #ifdef needed in the class body itself).
    intptr_t processHandle_ = 0;
    bool terminated_ = false;
};

}  // namespace swarm
