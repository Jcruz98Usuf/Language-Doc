# Phase 1.5 translation benchmark

Generated: 2026-09-21T23:40:55.261Z

> Automated flags (empty / repetition / source-copy / missing preserved tokens) are
> regression signals only. They are NOT a measure of medical translation accuracy;
> human review of the full outputs below is required before any clinical claim.

## English -> Swahili — ollama:dzgg/Qwen3.5-Uncensored-HauhauCS-Aggressive:4b

Runtime: Ollama (chat)  |  License: see model card  |  Warmup: 32425ms
Clean: **11/14**  |  empty 0  repetition 0  source-copy 0  preserve-misses 3  errors 0  |  mean latency **15479ms**

| id | category | output | flags | ms |
|---|---|---|---|---|
| en-greeting | greeting | Asante mara moja mwalimu. | ok | 10926 |
| en-conversation | conversation | Unafanya kama nani leo? | ok | 10816 |
| en-numbers | numbers | Kipato ni milioni 15,000 kwa siku tatu. | ok | 14560 |
| en-dates | dates | Makumbi yako ni tarehe 12 Machi, mwaka wa 2026. | ok | 16742 |
| en-names | names | Tafadhali upeleke Mama Amana kwenda kwenye eneo la nne. | missing: Amina | 15620 |
| en-clinic | clinic | Ninachukua dawa hii tangu leo kwa siku mbili na asubuhi, lakini hatatamati. | ok | 18605 |
| en-symptoms | symptoms | Njiani langu linakuwa na ukuu, na nina nguvu za hewa chini. | ok | 16628 |
| en-medication | medication | Ondoa chuma cha parasetamoli ya 500mg mara mbili kila siku baada ya maji. | missing: paracetamol|paracetamoli, 500, mg | 19552 |
| en-hotel | hotel | Nataka kurejesha mabano ya juu mbili kwa siku mbili na mafuniko yanayojumuisha. | ok | 17992 |
| en-office | office | Majadali ni jumanne; tafuta ripoti kabla ya siku hiyo na ukiwapa ninyozi. | missing: Jumatatu|Monday | 18477 |
| en-question | question | Unafuatilia kile ninavyosema? | ok | 12200 |
| en-negation | negation | Sina uwezo wa kula chakula chenye salu. | ok | 14045 |
| en-instruction | instruction | Fungua mkono wako na nasa kwa kasi. | ok | 12980 |
| en-clinic-2 | clinic | Daktari atakutambua baada ya mwanasiasa kufanya ukubwa wa damu yako. | ok | 17562 |

## Swahili -> English — ollama:dzgg/Qwen3.5-Uncensored-HauhauCS-Aggressive:4b

Runtime: Ollama (chat)  |  License: see model card  |  Warmup: 10632ms
Clean: **10/13**  |  empty 0  repetition 0  source-copy 0  preserve-misses 3  errors 0  |  mean latency **13400ms**

| id | category | output | flags | ms |
|---|---|---|---|---|
| sw-greeting | greeting | Evening greetings, doctor. | ok | 10874 |
| sw-conversation | conversation | The child has had a fever and cough since yesterday. | ok | 12812 |
| sw-numbers | numbers | I have lost my insurance card; its number is 2233. | ok | 14857 |
| sw-dates | dates | I started feeling pain on October 9th. | missing: 9 | 12375 |
| sw-names | names | Mother Fatuma needs her medicine at all times. | ok | 12969 |
| sw-clinic | clinic | I have been taking this medicine for one week but I still feel headaches. | ok | 15616 |
| sw-symptoms | symptoms | The arm is swollen, and the head is very swollen. | ok | 13376 |
| sw-medication | medication | Take one capsule of Amoxicillin 250mg three times a day. | missing: 250, mg | 15481 |
| sw-hotel | hotel | I would like a room with an ocean view; what is the daily rate? | ok | 15284 |
| sw-office | office | The Wednesday meeting has been postponed until Friday. | missing: Monday|Jumatatu | 13013 |
| sw-question | question | Do you understand what I am saying? | ok | 11695 |
| sw-negation | negation | I will not attend the meeting because I am a patient. | ok | 13521 |
| sw-instruction | instruction | High blood pressure and body temperature monitoring. | ok | 12321 |
