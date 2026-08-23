// Test-only helper: reports the argv it actually received, so a test can
// prove what SpawnedProcess's Windows command-line quoting really does to
// argument boundaries.
//
// This has to be a separate real executable, built with the same toolchain
// as swarm-node-agent, because the thing under test is precisely how the C
// runtime re-splits the single command-line string CreateProcess takes back
// into an argv array. Nothing in-process can observe that.
//
// Usage: argv_echo <output-file> [args...]
//
// Writes each of args... to <output-file>, one per line, in order, followed
// by a final sentinel line. The sentinel is what makes the test race-free:
// SpawnedProcess's destructor *kills* the child, so a test that stopped
// waiting as soon as the file merely existed could observe a half-written
// file. Waiting for the sentinel proves the child got all the way to the
// end before the handle went away.

#include <cstdio>
#include <fstream>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: argv_echo <output-file> [args...]\n");
        return 2;
    }
    std::ofstream out(argv[1], std::ios::binary);
    if (!out) {
        std::fprintf(stderr, "argv_echo: cannot open %s\n", argv[1]);
        return 3;
    }
    for (int i = 2; i < argc; ++i) {
        out << argv[i] << "\n";
    }
    out << "##ARGV_ECHO_END##\n";
    out.flush();
    return 0;
}
