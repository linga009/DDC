add_library(inference_engine
    src/inference_engine.cpp
    src/speculative.cpp
    src/http_server.cpp
    src/json_utils.cpp
    src/spawned_process.cpp
)
target_include_directories(inference_engine PUBLIC include)
target_link_libraries(inference_engine PUBLIC llama)
target_compile_features(inference_engine PUBLIC cxx_std_17)
if(WIN32)
    target_link_libraries(inference_engine PUBLIC ws2_32)
endif()

add_executable(swarm-cli src/main.cpp)
target_link_libraries(swarm-cli PRIVATE inference_engine)

add_executable(swarm-rpc-server src/rpc_server_main.cpp)
target_link_libraries(swarm-rpc-server PRIVATE ggml)

add_executable(swarm-node-agent src/node_agent_main.cpp)
target_link_libraries(swarm-node-agent PRIVATE inference_engine)

add_executable(swarm-launcher src/launcher_main.cpp)
target_link_libraries(swarm-launcher PRIVATE inference_engine)

add_subdirectory(tests)
