cmake_minimum_required(VERSION 3.14)
project(swarm_llm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_subdirectory(vendor/llama.cpp)
add_subdirectory(core)
