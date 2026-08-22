#include "swarm/json_utils.h"

#include <cctype>
#include <cstdio>
#include <stdexcept>

namespace swarm {

namespace {

// Returns the position of the ':' that follows a genuinely top-level
// occurrence of "key" in `body` -- i.e. a key belonging to the outermost
// JSON object, not one embedded inside a string value or nested inside a
// nested object/array. Returns std::string::npos if no such top-level key
// exists. Tracks {}/[] nesting depth in a single pass, correctly skipping
// over string contents (respecting \" escapes within strings) so that
// braces or quote characters inside string values never affect the depth
// count or get mistaken for structural JSON syntax.
size_t findTopLevelKeyColon(const std::string& body, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    int depth = 0;
    bool inString = false;
    for (size_t i = 0; i < body.size(); ++i) {
        char c = body[i];
        if (inString) {
            if (c == '\\' && i + 1 < body.size()) {
                ++i;  // skip the escaped character, whatever it is
                continue;
            }
            if (c == '"') {
                inString = false;
            }
            continue;
        }
        if (c == '"') {
            if (depth == 1 && body.compare(i, needle.size(), needle) == 0) {
                // A textual match at depth 1 could be a *key* (immediately
                // followed, modulo whitespace, by ':') or a top-level
                // *string value* that merely happens to equal the key text
                // (e.g. {"prompt":"n_predict","extra":"z","n_predict":5}
                // while looking for "n_predict" -- "prompt"'s value matches
                // the needle too). Only the former is a real key, so the
                // colon must immediately follow the closing quote rather
                // than being located via an unbounded forward search (which
                // could latch onto an unrelated later key's colon).
                size_t j = i + needle.size();
                while (j < body.size() && std::isspace(static_cast<unsigned char>(body[j]))) {
                    ++j;
                }
                if (j < body.size() && body[j] == ':') {
                    return j;
                }
            }
            inString = true;
            continue;
        }
        if (c == '{' || c == '[') {
            ++depth;
        } else if (c == '}' || c == ']') {
            --depth;
        }
    }
    return std::string::npos;
}

}  // namespace

bool extractJsonString(const std::string& body, const std::string& key, std::string& out) {
    size_t colon = findTopLevelKeyColon(body, key);
    if (colon == std::string::npos) {
        return false;
    }
    // Anchor to the character immediately after the colon (skipping
    // whitespace only), mirroring extractJsonInt's own anchoring discipline
    // -- do NOT do an unbounded forward search for the next '"' character,
    // since that would happily latch onto some unrelated later quoted text
    // (another key's name, another key's value, even a key from inside a
    // nested object) whenever this key's actual value isn't a string at all
    // (a number, null, true/false, a nested object, or an array). If the
    // first non-whitespace character after the colon isn't '"', this key's
    // value is simply not a JSON string, so report that via `false`.
    size_t i = colon + 1;
    while (i < body.size() && std::isspace(static_cast<unsigned char>(body[i]))) {
        ++i;
    }
    if (i >= body.size() || body[i] != '"') {
        return false;
    }
    size_t quoteStart = i;

    std::string result;
    i = quoteStart + 1;
    while (i < body.size() && body[i] != '"') {
        if (body[i] == '\\' && i + 1 < body.size()) {
            char next = body[i + 1];
            if (next == '"') { result += '"'; i += 2; continue; }
            if (next == '\\') { result += '\\'; i += 2; continue; }
            if (next == 'n') { result += '\n'; i += 2; continue; }
            if (next == 't') { result += '\t'; i += 2; continue; }
            if (next == 'r') { result += '\r'; i += 2; continue; }
            if (next == 'b') { result += '\b'; i += 2; continue; }
            if (next == 'f') { result += '\f'; i += 2; continue; }
            if (next == 'u' && i + 5 < body.size()) {
                std::string hex = body.substr(i + 2, 4);
                bool validHex = hex.size() == 4;
                for (char hc : hex) {
                    if (!std::isxdigit(static_cast<unsigned char>(hc))) { validHex = false; break; }
                }
                if (validHex) {
                    unsigned int codepoint = static_cast<unsigned int>(std::stoul(hex, nullptr, 16));
                    if (codepoint < 0x80) {
                        result += static_cast<char>(codepoint);
                        i += 6;
                        continue;
                    }
                }
                // Not a recognized \u00XX-below-0x80 form -- fall through to
                // the default handling below (copy the backslash literally),
                // same as any other unrecognized escape.
            }
        }
        result += body[i];
        ++i;
    }
    if (i >= body.size()) {
        return false;  // unterminated string
    }
    out = result;
    return true;
}

bool extractJsonInt(const std::string& body, const std::string& key, int& out) {
    size_t colon = findTopLevelKeyColon(body, key);
    if (colon == std::string::npos) {
        return false;
    }
    size_t i = colon + 1;
    while (i < body.size() && std::isspace(static_cast<unsigned char>(body[i]))) {
        ++i;
    }
    size_t numStart = i;
    if (i < body.size() && body[i] == '-') {
        ++i;
    }
    while (i < body.size() && std::isdigit(static_cast<unsigned char>(body[i]))) {
        ++i;
    }
    if (i == numStart || (i == numStart + 1 && body[numStart] == '-')) {
        return false;
    }
    // A digit run of arbitrary length parses fine up to this point even
    // when it doesn't fit in an int (e.g. a client sending an absurdly
    // large n_predict); std::stoi throws std::out_of_range in that case.
    // This function's contract is to report unparseable input via a bool
    // return, not to let a malformed/adversarial request body crash the
    // process, so that exception is caught here rather than propagated.
    try {
        out = std::stoi(body.substr(numStart, i - numStart));
    } catch (const std::out_of_range&) {
        return false;
    }
    return true;
}

bool extractJsonBool(const std::string& body, const std::string& key, bool& out) {
    size_t colon = findTopLevelKeyColon(body, key);
    if (colon == std::string::npos) {
        return false;
    }
    size_t i = colon + 1;
    while (i < body.size() && std::isspace(static_cast<unsigned char>(body[i]))) {
        ++i;
    }
    if (body.compare(i, 4, "true") == 0) {
        out = true;
        return true;
    }
    if (body.compare(i, 5, "false") == 0) {
        out = false;
        return true;
    }
    return false;
}

std::string jsonEscapeString(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

}  // namespace swarm
