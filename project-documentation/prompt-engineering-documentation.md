# Prompt Engineering Documentation — Recursion (Coding Mentor Agent)

## 1. Overview

Recursion is an AI coding mentor agent. Unlike a plain "fix my code" tool, it is designed to
**teach** — explaining reasoning, not just handing over corrected code. This behaviour is
achieved entirely through prompt engineering applied to the Groq LLM API
(`openai/gpt-oss-120b`), with no fine-tuning involved.

## 2. System prompt (role prompting + behavioural constraints)

The system prompt is sent with every request and defines the agent's persona and rules:

```
You are Recursion, a patient and encouraging coding mentor. You do not just hand over fixed code — you teach.
Rules:
- Explain the reasoning behind bugs and suggestions, not just the fix.
- When reviewing code, be specific: reference line-level logic, not vague generalities.
- Use short paragraphs. Use code blocks (triple backticks) only when showing a snippet, keep snippets minimal and focused.
- Be encouraging but honest — point out real issues clearly.
- If the user's message is a general question with no code, answer as a mentor teaching a concept, with a short example if useful.
- Keep responses focused and not overly long — a mentor gives a clear, digestible answer, not an essay.
```

**Principles applied:**

| Principle | How it's used |
|---|---|
| Role / persona prompting | "You are Recursion, a patient and encouraging coding mentor" anchors tone and identity across every turn. |
| Explicit behavioural rules | A numbered rule list constrains output style (short paragraphs, minimal code blocks) rather than relying on the model's default verbosity. |
| Negative constraint | "You do not just hand over fixed code" explicitly rules out the lazy failure mode (dumping a corrected snippet with no explanation). |
| Tone calibration | "Encouraging but honest" balances two competing goals — supportive mentorship without hiding real problems. |
| Output length control | Final rule caps response length, preventing the model from producing essay-length answers unsuitable for a chat UI. |

## 3. Dynamic task prompts (instruction templating per action)

Four buttons in the UI — **Explain**, **Find bugs**, **Optimize**, **Review style** — each wrap
the user's code in a different instruction template before it reaches the LLM:

```
explain:  Explain what this code does, step by step:
debug:    Find and explain any bugs or issues in this code:
optimize: Suggest ways to optimize this code for performance or clarity, and explain why:
review:   Review this code for style and best practices, like a mentor giving feedback:
```

The detected/selected programming language is interpolated into the instruction
(e.g. "Explain what this code (Python) does..."), giving the model explicit context instead of
asking it to guess the language from the snippet alone.

**Why this matters:** the same system prompt (persona) is reused across all four actions, while
the *task instruction* changes per button. This separates **who the model is** (constant) from
**what it's being asked to do right now** (variable) — a standard prompt engineering pattern for
multi-function agents.

## 4. Context management (token budget as a prompt engineering concern)

Sending the entire growing conversation history on every request risks exceeding the LLM
provider's per-minute token limits. To manage this:

- Only the last **8 messages** of conversation history are sent with each request
  (`MAX_HISTORY_MESSAGES = 8`), not the full accumulated history.
- This keeps prompts small and fast while still preserving recent conversational context
  (follow-up questions still make sense to the model).

## 5. Structured logging as prompt/response pairs

Every user message and every mentor reply is logged to SQLite tagged with the `action` type
(`chat`, `explain`, `debug`, `optimize`, `review`) and the `language`. This is not itself a
prompt engineering technique, but it enables the **Progress dashboard** feature, which
summarises how a student has been using the mentor (e.g. "asked to debug Python code 5 times").

## 6. Design rationale — why this counts as prompt engineering (for viva)

- The agent's entire behaviour (mentor-style teaching vs. blunt answers) is controlled purely
  through the system prompt — no separate training or fine-tuning step.
- Task-specific instructions are templated rather than hardcoded per button, keeping the prompt
  logic maintainable and easy to extend with new actions.
- Constraints (short answers, no unexplained code dumps, honest-but-encouraging tone) directly
  address common LLM failure modes (verbosity, hallucinated confidence, blunt criticism).
- History trimming is a practical prompt engineering trade-off between context richness and
  staying within the LLM provider's rate limits.
