#include "swarm/spawned_process.h"

#include <stdexcept>

#ifdef _WIN32
#include <windows.h>
#else
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace swarm {

#ifdef _WIN32

namespace {

// CreateProcess takes ONE mutable command-line string, not an argv array --
// but it does NOT invoke a shell (unlike std::system()), so no argument
// value can inject a second command via ";"/"&&"/backticks. Each argument
// still needs quoting so a value containing a space or a literal '"'
// becomes one argument rather than splitting into extra ones or breaking
// the quoting itself.
//
// Getting this exactly right matters more than it looks. The child re-splits
// this flat string using the standard CommandLineToArgvW/C-runtime rules,
// where backslashes and quotes interact:
//
//   * 2n backslashes followed by '"'  -> n backslashes, and the quote is a
//                                        DELIMITER (it toggles quoted mode)
//   * 2n+1 backslashes followed by '"' -> n backslashes, and the quote is a
//                                        LITERAL character
//   * backslashes not followed by '"' -> literal backslashes
//
// So escaping only the quotes (and leaving backslashes alone) is not enough:
// a value containing \" would emit an even backslash run before a quote,
// which CLOSES quoted mode and lets the following space start an additional
// argument -- flag injection into the spawned child, which accepts flags
// like --remote. A value merely ENDING in a backslash (an ordinary Windows
// directory path) is the same bug in benign clothing: it would escape the
// closing quote and swallow every argument after it.
//
// Both cases are covered by spawned_process_test.cpp, which asserts against
// the argv a real spawned child actually received.
std::string quoteWindowsArg(const std::string& arg) {
    std::string quoted = "\"";
    size_t pendingBackslashes = 0;
    for (char c : arg) {
        if (c == '\\') {
            // Undecided until we see what follows: how these must be
            // emitted depends on whether a '"' comes next.
            ++pendingBackslashes;
            continue;
        }
        if (c == '"') {
            // Double the run so it survives as literal backslashes, then
            // add one more to make this quote literal rather than a
            // delimiter.
            quoted.append(pendingBackslashes * 2 + 1, '\\');
            quoted += '"';
        } else {
            // Not before a quote: these stay as-is.
            quoted.append(pendingBackslashes, '\\');
            quoted += c;
        }
        pendingBackslashes = 0;
    }
    // A trailing run sits immediately before our closing quote, so it must
    // be doubled or it would escape that quote.
    quoted.append(pendingBackslashes * 2, '\\');
    quoted += '"';
    return quoted;
}

std::string buildWindowsCommandLine(const std::vector<std::string>& argv) {
    std::string cmdLine;
    for (size_t i = 0; i < argv.size(); ++i) {
        if (i > 0) {
            cmdLine += " ";
        }
        cmdLine += quoteWindowsArg(argv[i]);
    }
    return cmdLine;
}

}  // namespace

SpawnedProcess::SpawnedProcess(const std::vector<std::string>& argv) {
    if (argv.empty()) {
        throw std::runtime_error("SpawnedProcess: argv must not be empty");
    }
    std::string cmdLine = buildWindowsCommandLine(argv);

    STARTUPINFOA startupInfo{};
    startupInfo.cb = sizeof(startupInfo);
    PROCESS_INFORMATION processInfo{};

    // CreateProcess needs a mutable buffer for the command line, not a
    // const char* -- it may rewrite it in place.
    std::vector<char> mutableCmdLine(cmdLine.begin(), cmdLine.end());
    mutableCmdLine.push_back('\0');

    BOOL ok = CreateProcessA(
        nullptr,                 // lpApplicationName: nullptr means "resolve argv[0] via PATH from lpCommandLine"
        mutableCmdLine.data(),
        nullptr, nullptr,        // default process/thread security attributes
        FALSE,                   // don't inherit handles
        CREATE_NO_WINDOW,        // no console window popping up for a background service process
        nullptr,                 // inherit the parent's environment
        nullptr,                 // inherit the parent's working directory
        &startupInfo,
        &processInfo);

    if (!ok) {
        throw std::runtime_error("SpawnedProcess: failed to start \"" + argv[0] + "\"");
    }
    // The thread handle is never needed after this point -- only the
    // process handle is kept, for terminate()/cleanup.
    CloseHandle(processInfo.hThread);
    processHandle_ = reinterpret_cast<intptr_t>(processInfo.hProcess);
}

SpawnedProcess::~SpawnedProcess() {
    terminate();
    CloseHandle(reinterpret_cast<HANDLE>(processHandle_));
}

void SpawnedProcess::terminate() {
    if (terminated_) {
        return;
    }
    terminated_ = true;
    TerminateProcess(reinterpret_cast<HANDLE>(processHandle_), 1);
    // Best-effort, bounded wait for the OS to finish teardown -- if it
    // doesn't happen within this window, terminate() still returns rather
    // than blocking indefinitely.
    WaitForSingleObject(reinterpret_cast<HANDLE>(processHandle_), 2000);
}

#else  // POSIX

SpawnedProcess::SpawnedProcess(const std::vector<std::string>& argv) {
    if (argv.empty()) {
        throw std::runtime_error("SpawnedProcess: argv must not be empty");
    }
    std::vector<char*> cArgv;
    for (const auto& arg : argv) {
        cArgv.push_back(const_cast<char*>(arg.c_str()));
    }
    cArgv.push_back(nullptr);

    pid_t pid = fork();
    if (pid < 0) {
        throw std::runtime_error("SpawnedProcess: fork failed");
    }
    if (pid == 0) {
        // Child: execvp replaces this process's image entirely -- it never
        // returns on success. execvp (not execv) resolves argv[0] via
        // PATH, matching CreateProcess's own PATH-search behavior above.
        // NOTE (disclosed simplification, not this platform's primary
        // target -- this project builds and tests on Windows/MSYS2 only):
        // a failed execvp here cannot synchronously report failure back to
        // the parent (they are different processes after fork()); the
        // child just exits 127 and the parent only learns spawn failed
        // later, via the health-check timeout. A full fix (a self-pipe
        // used to relay exec() errno back before exec) is real, known
        // extra complexity not justified for a platform this project
        // doesn't actively build or test on.
        execvp(cArgv[0], cArgv.data());
        _exit(127);
    }
    processHandle_ = static_cast<intptr_t>(pid);
}

SpawnedProcess::~SpawnedProcess() {
    terminate();
}

void SpawnedProcess::terminate() {
    if (terminated_) {
        return;
    }
    terminated_ = true;
    pid_t pid = static_cast<pid_t>(processHandle_);
    kill(pid, SIGKILL);
    int status;
    waitpid(pid, &status, 0);
}

#endif

}  // namespace swarm
