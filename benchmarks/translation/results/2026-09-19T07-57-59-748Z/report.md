# Phase 1.5 translation benchmark

Generated: 2026-09-19T07:57:59.753Z

> Automated flags (empty / repetition / source-copy / missing preserved tokens) are
> regression signals only. They are NOT a measure of medical translation accuracy;
> human review of the full outputs below is required before any clinical claim.

## English -> Swahili — ollama:qwen3:1.7b

Runtime: Ollama (chat)  |  License: Apache-2.0  |  Warmup: 9147ms
Clean: **11/14**  |  empty 0  repetition 0  source-copy 0  preserve-misses 3  errors 0  |  mean latency **3792ms**

| id | category | output | flags | ms |
|---|---|---|---|---|
| en-greeting | greeting | Salaamu anaka, doktor. | ok | 1719 |
| en-conversation | conversation | Kaka kama na kiasi ya matokeo? | ok | 2363 |
| en-numbers | numbers | Mkaka ya mali kati ya 15,000 shillinga kwa kiasi na 3 dani. | ok | 4188 |
| en-dates | dates | Sisi kaka ya apokusi na 12 martsi 2026. | missing: Machi|March | 3254 |
| en-names | names | Siku kifungu Njia na matokeo 4. | missing: Amina | 3178 |
| en-clinic | clinic | Aku kisasa mazuri ya medikinzi na 5 daga, lakini mbalimbali ni kama kama. | ok | 4937 |
| en-symptoms | symptoms | Mwaka mimi kila na kifaa ya kisasa na kifaa ya kamaa. | ok | 3914 |
| en-medication | medication | Kaka na kila tablè ya paracetamol 500 mg mbili kama kiasi kati kamilia. | ok | 4710 |
| en-hotel | hotel | Mikoko kwa matokeo ya 2 nadii na kila kiasi kati ya kiasi kati ya kiasi. | ok | 4889 |
| en-office | office | Mkaka ya matokeo kwa mbili 1, sana kuwafanisha mkono yako kama kiasi. | missing: Jumatatu|Monday | 4760 |
| en-question | question | Maka mungumu kwa mwanamko ya mbalimbali? | ok | 2957 |
| en-negation | negation | Mikoko kwa matokeo kati ya matokeo kila kiasi. | ok | 3499 |
| en-instruction | instruction | Bakamka na kaka wa mwanafani ya kila kifaa na kamaa. | ok | 3665 |
| en-clinic-2 | clinic | Njia kila mwanataka kisha na nchi ya mbali wana mwalimu kiasi mbalimbali yangu. | ok | 5048 |

## Swahili -> English — ollama:qwen3:1.7b

Runtime: Ollama (chat)  |  License: Apache-2.0  |  Warmup: 1540ms
Clean: **10/13**  |  empty 0  repetition 0  source-copy 0  preserve-misses 3  errors 0  |  mean latency **2577ms**

| id | category | output | flags | ms |
|---|---|---|---|---|
| sw-greeting | greeting | Message from doctor. | ok | 1582 |
| sw-conversation | conversation | A child is born with a heart defect. | ok | 2414 |
| sw-numbers | numbers | This patient's medical record number is 2233. | ok | 2909 |
| sw-dates | dates | Not prescribed for use in adults over 18 years of age. | missing: 9, October|Oktoba | 2866 |
| sw-names | names | Mother Fatuma is giving her young child medicine. | ok | 2324 |
| sw-clinic | clinic | Although this medicine was prescribed by a doctor, but he did not take it. | ok | 3845 |
| sw-symptoms | symptoms | He will be admitted to the hospital for treatment. | ok | 2344 |
| sw-medication | medication | This is a 250-mg antibiotic capsule taken once daily. | missing: amoxicillin|amoksilini | 3242 |
| sw-hotel | hotel | When will you be able to go out in the sea? | ok | 2892 |
| sw-office | office | The patient was admitted to the hospital. | missing: Monday|Jumatatu, Friday|Ijumaa | 2213 |
| sw-question | question | What is the purpose of this examination? | ok | 1936 |
| sw-negation | negation | This is a mistake caused by something. | ok | 2267 |
| sw-instruction | instruction | Blood pressure readings for a patient and their blood sugar levels. | ok | 2673 |
