# ENG-211 browser verification

Verified on 2026-07-14 with headless Chromium against both real demo dev servers and the real Anthropic streaming transport (no mocked model or wire).

- Maple (`http://localhost:3000/vendo`, `thr_maple_demo`): sent `My name is Farouk and I bank here for my bakery.`, then `What is my name?`. The persisted thread contained four messages and turn 2 replied, `Your name is Farouk`.
- Cadence (`http://localhost:3010/assistant`, `thr_cadence_demo`): repeated the same two turns. The persisted thread contained four messages and turn 2 replied, `Your name is Farouk`.
- Each completed server stream was rendered from the persisted thread before capture, also exercising thread restoration across a page reload.

Evidence: `maple-turn-1.png`, `maple-turn-2.png`, `cadence-turn-1.png`, and `cadence-turn-2.png`.
