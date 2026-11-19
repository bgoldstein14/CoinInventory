# Project instructions

## Code comments

Keep comments concise and relevant to the code in front of them.

- A short doc comment on each function, class or exported constant saying what it is for.
- Brief inline comments to label the steps of a longer process.
- Explain *why* only where it is not obvious: a trap, an ordering dependency, a domain fact, a workaround.
- A longer explanation only where the logic is genuinely complex, and then structured and to the point.

Do not write:

- change history or dates ("used to", "was changed because", "until 2026-…");
- narration of decisions or conversations, or quotes of the owner;
- defensive or self-reflective prose, essays, ALL-CAPS banners, `***` emphasis;
- the same explanation repeated in several files;
- restatements of what the code plainly does.

Big-picture explanations of how the system works belong in `README.md` or `docs/`, not in source comments. Design rationale for a change goes in its spec under `docs/superpowers/specs/`.
