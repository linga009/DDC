#pragma once

#include <string>

namespace swarm {

// Extracts the string value of a top-level JSON key from `body`, e.g.
// extractJsonString(R"({"prompt":"hi \"there\""})", "prompt", out) sets
// out = "hi \"there\"" and returns true. Returns false if `key` isn't
// present as a top-level key with a string value. Handles \", \\, and \n
// escapes only -- the set this project's own JSON producers (the
// coordinator's JSON.stringify, and this project's own response-writing
// code) ever emit; this is a purpose-built field extractor, not a general
// JSON parser, and must not be extended toward one.
bool extractJsonString(const std::string& body, const std::string& key, std::string& out);

// Extracts the integer value of a top-level JSON key, e.g.
// extractJsonInt(R"({"n_predict":64})", "n_predict", out) sets out = 64
// and returns true. Handles an optional leading '-'. Returns false if
// `key` isn't present as a top-level key with an integer value.
bool extractJsonInt(const std::string& body, const std::string& key, int& out);

// Escapes `s` for embedding as a JSON string value (without the
// surrounding quotes) -- \", \\, \n, \r, \t, and control characters below
// 0x20 as \u00XX.
std::string jsonEscapeString(const std::string& s);

}  // namespace swarm
