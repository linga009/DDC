include(FetchContent)
FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.18.0.zip
    URL_HASH SHA256=63b9c77751a5b8f492486005f67533fdc58682b67476fcb91650be5958d5195a
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

add_executable(inference_engine_test inference_engine_test.cpp speculative_test.cpp http_server_test.cpp json_utils_test.cpp node_agent_test.cpp spawned_process_test.cpp launcher_test.cpp)
target_link_libraries(inference_engine_test PRIVATE inference_engine GTest::gtest_main)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_TEST_MODEL_DIR="${CMAKE_SOURCE_DIR}/models"
    SWARM_MOE_TEST_MODEL_DIR="${CMAKE_SOURCE_DIR}/models"
)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_RPC_SERVER_PATH="$<TARGET_FILE:swarm-rpc-server>"
)
# $<TARGET_FILE:...> above only supplies a path string -- it does not make
# CMake build swarm-rpc-server before inference_engine_test. Without this,
# a clean `cmake --build build --target inference_engine_test` can leave
# the RPC-split test pointing at a stale or missing executable.
add_dependencies(inference_engine_test swarm-rpc-server)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_NODE_AGENT_PATH="$<TARGET_FILE:swarm-node-agent>"
)
add_dependencies(inference_engine_test swarm-node-agent)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_LAUNCHER_PATH="$<TARGET_FILE:swarm-launcher>"
)
add_dependencies(inference_engine_test swarm-launcher)

# Test-only helper that reports the argv it actually received. SpawnedProcess's
# Windows quoting can only be verified by a real second process, because what
# is being tested is how the C runtime re-splits CreateProcess's single
# command-line string back into argv.
add_executable(argv_echo argv_echo_main.cpp)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_ARGV_ECHO_PATH="$<TARGET_FILE:argv_echo>"
)
add_dependencies(inference_engine_test argv_echo)

include(GoogleTest)
gtest_discover_tests(inference_engine_test)
