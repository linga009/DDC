#pragma once

#include <string>

namespace swarm {

// Extracts the string value of a genuinely top-level JSON key from `body`,
// e.g. extractJsonString(R"({"prompt":"hi \"there\""})", "prompt", out)
// sets out = "hi \"there\"" and returns true. "Top-level" means a key of
// the outermost JSON object -- a same-named key that occurs only inside a
// nested object/array value (e.g. {"prompt":{"prompt":"x"},"prompt":"y"})
// or that is embedded inside an unrelated string value does not match; the
// scan tracks {}/[] nesting depth and skips over string contents to tell
// these apart. Returns false if `key` isn't present as a top-level key
// with a string value. Handles \", \\, \n, \t, \r, \b, \f, and \u00XX (for
// codepoints below 0x80) escapes -- the full set this project's own JSON
// producers (the coordinator's JSON.stringify, and this project's own
// response-writing code) ever emit; this is a purpose-built field
// extractor, not a general JSON parser, and must not be extended toward
// one (in particular, general \uXXXX decoding for codepoints >= 0x80 and
// UTF-16 surrogate pairs is explicitly out of scope).
bool extractJsonString(const std::string& body, const std::string& key, std::string& out);

// Extracts the integer value of a genuinely top-level JSON key, e.g.
// extractJsonInt(R"({"n_predict":64})", "n_predict", out) sets out = 64
// and returns true. "Top-level" means a key of the outermost JSON object,
// not one belonging to a nested object/array or embedded inside a string
// value -- see extractJsonString's comment for how that's determined.
// Handles an optional leading '-'. Returns false if `key` isn't present as
// a top-level key with an integer value.
bool extractJsonInt(const std::string& body, const std::string& key, int& out);

// Extracts the boolean value of a genuinely top-level JSON key, e.g.
// extractJsonBool(R"({"stream":true})", "stream", out) sets out = true and
// returns true. "Top-level" has the same meaning as extractJsonString's
// own definition -- see its comment. Returns false if `key` isn't present
// as a top-level key with a literal `true` or `false` value (a quoted
// "true"/"false" string, or 1/0, do not count).
bool extractJsonBool(const std::string& body, const std::string& key, bool& out);

// Escapes `s` for embedding as a JSON string value (without the
// surrounding quotes) -- \", \\, \n, \r, \t, and control characters below
// 0x20 as \u00XX.
std::string jsonEscapeString(const std::string& s);

}  // namespace swarm
