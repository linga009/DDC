export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Flattens an OpenAI-shaped messages[] array into the same plain-text
// "Role: content" transcript convention the dashboard's buildChatPrompt()
// (coordinator/public/app.js) already uses -- this project has no
// chat-template support anywhere, so reply quality depends entirely on how
// well the selected model continues this transcript. A trailing
// "Assistant:" (no colon-space content) is appended unconditionally,
// prompting the model to continue as the assistant.
//
// Unlike the dashboard's own copy of this idea (which only ever sees
// user/assistant entries in its own chatHistory and collapses any other
// role into "Assistant:"), a "system" message here gets its own "System:"
// label -- a real OpenAI messages[] array can and does contain one.
export function buildPromptFromMessages(messages: ChatMessage[]): string {
  const label = (role: ChatMessage["role"]) =>
    role === "user" ? "User" : role === "system" ? "System" : "Assistant";
  const transcript = messages.map(m => `${label(m.role)}: ${m.content}`).join("\n");
  return (transcript ? transcript + "\n" : "") + "Assistant:";
}
