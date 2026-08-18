---
"@vendoai/vendo": patch
---

A "no tool for that" conclusion now requires the search. The capability-miss
prompt told the agent to report a no-matching-tool miss "before replying", and
the discovery section told it to search find_tools "before concluding you
can't" — two instructions, one situation, and the model may satisfy either. On
a live text-channel transfer ask it satisfied the first: filed the miss off its
equipped read tools alone and told the customer it couldn't send money, while
"Send money" sat one find_tools call away. The miss bullet now names the search
as the only way to establish "no available tool" on a surface that has one.
