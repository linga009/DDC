#include "swarm/json_utils.h"

#include <cctype>
#include <cstdio>
#include <stdexcept>

namespace swarm {

namespace {

// Locates the ':' that follows a top-level occurrence of `"key"` in `body`.
//
// A plain body.find("\"key\"") can match text inside an *earlier* key's
// string value that happens to equal the target key name (e.g. body =
// {"prompt":"n_predict","extra":"z","n_predict":5} while looking for
// "n_predict": the first occurrence is the *value* of "prompt", not the
// "n_predict" key). If left unguarded, the colon search that follows can
// then latch onto an unrelated key's colon and either return the wrong
// value or spuriously fail. Since JSON object keys are always immediately
// preceded (modulo whitespace) by '{' or ',', checking that context is
// enough to reject false matches without turning this into a real parser.
size_t findTopLevelKeyColon(const std::string& body, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    size_t searchFrom = 0;
    while (true) {
        size_t keyPos = body.find(needle, searchFrom);
        if (keyPos == std::string::npos) {
            return std::string::npos;
        }
        size_t j = keyPos;
        while (j > 0 && std::isspace(static_cast<unsigned char>(body[j - 1]))) {
            --j;
        }
        bool validKeyPosition = (j == 0) || body[j - 1] == '{' || body[j - 1] == ',';
        if (validKeyPosition) {
            return body.find(':', keyPos + needle.size());
        }
        searchFrom = keyPos + 1;
    }
}

}  // namespace

bool extractJsonString(const std::string& body, const std::string& key, std::string& out) {
    size_t colon = findTopLevelKeyColon(body, key);
    if (colon == std::string::npos) {
        return false;
    }
    size_t quoteStart = body.find('"', colon);
    if (quoteStart == std::string::npos) {
        return false;
    }

    std::string result;
    size_t i = quoteStart + 1;
    while (i < body.size() && body[i] != '"') {
        if (body[i] == '\\' && i + 1 < body.size()) {
            char next = body[i + 1];
            if (next == '"') { result += '"'; i += 2; continue; }
            if (next == '\\') { result += '\\'; i += 2; continue; }
            if (next == 'n') { result += '\n'; i += 2; continue; }
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
