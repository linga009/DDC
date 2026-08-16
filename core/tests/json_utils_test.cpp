#include "swarm/json_utils.h"

#include <gtest/gtest.h>

namespace {

TEST(JsonUtilsTest, ExtractsASimpleStringValue) {
    std::string out;
    ASSERT_TRUE(swarm::extractJsonString(R"({"prompt":"hello"})", "prompt", out));
    EXPECT_EQ(out, "hello");
}

TEST(JsonUtilsTest, ExtractsAStringValueWithEscapedQuotesAndNewline) {
    std::string out;
    ASSERT_TRUE(swarm::extractJsonString(R"({"prompt":"say \"hi\"\nnow"})", "prompt", out));
    EXPECT_EQ(out, "say \"hi\"\nnow");
}

TEST(JsonUtilsTest, ReturnsFalseWhenTheKeyIsMissing) {
    std::string out;
    EXPECT_FALSE(swarm::extractJsonString(R"({"other":"x"})", "prompt", out));
}

TEST(JsonUtilsTest, ExtractsAPositiveInteger) {
    int out = 0;
    ASSERT_TRUE(swarm::extractJsonInt(R"({"n_predict":64})", "n_predict", out));
    EXPECT_EQ(out, 64);
}

TEST(JsonUtilsTest, ExtractsANegativeInteger) {
    int out = 0;
    ASSERT_TRUE(swarm::extractJsonInt(R"({"n_predict":-5})", "n_predict", out));
    EXPECT_EQ(out, -5);
}

TEST(JsonUtilsTest, ReturnsFalseWhenTheIntKeyIsMissing) {
    int out = 0;
    EXPECT_FALSE(swarm::extractJsonInt(R"({"other":1})", "n_predict", out));
}

TEST(JsonUtilsTest, WorksWithBothKeysInTheSameObjectRegardlessOfOrder) {
    std::string prompt;
    int n = 0;
    std::string body = R"({"n_predict":32,"prompt":"hi"})";
    ASSERT_TRUE(swarm::extractJsonInt(body, "n_predict", n));
    ASSERT_TRUE(swarm::extractJsonString(body, "prompt", prompt));
    EXPECT_EQ(n, 32);
    EXPECT_EQ(prompt, "hi");
}

TEST(JsonUtilsTest, EscapesQuotesBackslashesAndNewlinesForJsonEmbedding) {
    EXPECT_EQ(swarm::jsonEscapeString("say \"hi\"\\now\n"), R"(say \"hi\"\\now\n)");
}

TEST(JsonUtilsTest, RoundTripsAnEscapedStringBackThroughExtraction) {
    std::string original = "line one\nline \"two\"\\ end";
    std::string body = R"({"prompt":")" + swarm::jsonEscapeString(original) + R"("})";
    std::string out;
    ASSERT_TRUE(swarm::extractJsonString(body, "prompt", out));
    EXPECT_EQ(out, original);
}

// --- Additional regression tests beyond the brief's 9, added after
// probing the given implementation and finding two real bugs during
// transcription (see task-2-report.md for full explanation): ---

TEST(JsonUtilsTest, DoesNotMistakeAnEarlierValueThatEqualsTheKeyNameForTheKey) {
    // "prompt"'s value literally equals "n_predict", and a third key
    // ("extra") sits between it and the real "n_predict" key. A naive
    // substring search for "\"n_predict\"" latches onto the text inside
    // the "prompt" value, then finds "extra"'s colon instead of the real
    // one, and fails. The key search must be anchored to actual key
    // positions (immediately after '{' or ',') to get this right.
    std::string body = R"({"prompt":"n_predict","extra":"z","n_predict":5})";
    int out = 0;
    ASSERT_TRUE(swarm::extractJsonInt(body, "n_predict", out));
    EXPECT_EQ(out, 5);
}

TEST(JsonUtilsTest, ReturnsFalseRatherThanThrowingOnAnOutOfRangeInteger) {
    // std::stoi throws std::out_of_range for a digit run that doesn't fit
    // in an int. n_predict is attacker-controlled once this is wired to
    // parse real HTTP request bodies, so an oversized value must be
    // reported as unparseable, not allowed to crash the process.
    std::string body = R"({"n_predict":99999999999999999999})";
    int out = 0;
    EXPECT_FALSE(swarm::extractJsonInt(body, "n_predict", out));
}

}  // namespace
