#include "swarm/inference_engine.h"

#include <gtest/gtest.h>

TEST(ResolveSpeculativeAcceptance, AcceptsAllDraftTokensPlusBonus) {
    std::vector<int32_t> draft{1, 2, 3};
    std::vector<int32_t> target{1, 2, 3, 99};

    auto accepted = swarm::resolve_speculative_acceptance(draft, target);

    EXPECT_EQ(accepted, (std::vector<int32_t>{1, 2, 3, 99}));
}

TEST(ResolveSpeculativeAcceptance, AcceptsPartialPrefixThenCorrects) {
    std::vector<int32_t> draft{1, 2, 3};
    std::vector<int32_t> target{1, 5, 3, 99};

    auto accepted = swarm::resolve_speculative_acceptance(draft, target);

    EXPECT_EQ(accepted, (std::vector<int32_t>{1, 5}));
}

TEST(ResolveSpeculativeAcceptance, RejectsImmediatelyOnFirstMismatch) {
    std::vector<int32_t> draft{1, 2, 3};
    std::vector<int32_t> target{7, 2, 3, 99};

    auto accepted = swarm::resolve_speculative_acceptance(draft, target);

    EXPECT_EQ(accepted, (std::vector<int32_t>{7}));
}

TEST(ResolveSpeculativeAcceptance, HandlesSingleTokenDraft) {
    std::vector<int32_t> draft{42};
    std::vector<int32_t> target{42, 100};

    auto accepted = swarm::resolve_speculative_acceptance(draft, target);

    EXPECT_EQ(accepted, (std::vector<int32_t>{42, 100}));
}
