cmake_minimum_required(VERSION 3.14)
project(swarm_llm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

enable_testing()

set(GGML_RPC ON CACHE BOOL "" FORCE)

add_subdirectory(vendor/llama.cpp)
add_subdirectory(core)
