include(FetchContent)
FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.18.0.zip
    URL_HASH SHA256=63b9c77751a5b8f492486005f67533fdc58682b67476fcb91650be5958d5195a
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

add_executable(inference_engine_test inference_engine_test.cpp)
target_link_libraries(inference_engine_test PRIVATE inference_engine GTest::gtest_main)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_TEST_MODEL_DIR="${CMAKE_SOURCE_DIR}/models"
)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_RPC_SERVER_PATH="$<TARGET_FILE:swarm-rpc-server>"
)

include(GoogleTest)
gtest_discover_tests(inference_engine_test)
