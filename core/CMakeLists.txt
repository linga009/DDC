add_library(inference_engine
    src/inference_engine.cpp
)
target_include_directories(inference_engine PUBLIC include)
target_link_libraries(inference_engine PUBLIC llama)
target_compile_features(inference_engine PUBLIC cxx_std_17)

add_executable(swarm-cli src/main.cpp)
target_link_libraries(swarm-cli PRIVATE inference_engine)

add_subdirectory(tests)
