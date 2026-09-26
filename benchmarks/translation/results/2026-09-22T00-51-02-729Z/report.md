# Phase 1.5 translation benchmark

Generated: 2026-09-22T00:51:02.733Z

> Automated flags (empty / repetition / source-copy / missing preserved tokens) are
> regression signals only. They are NOT a measure of medical translation accuracy;
> human review of the full outputs below is required before any clinical claim.

## English -> French — local-mt-hf

Runtime: transformers.js + ONNX Runtime, q8 (cached locally)  |  License: Helsinki-NLP/opus-mt-en-fr = Apache-2.0  |  Warmup: 3250ms
Clean: **14/14**  |  empty 0  repetition 0  source-copy 0  preserve-misses 0  errors 0  |  mean latency **540ms**

| id | category | output | flags | ms |
|---|---|---|---|---|
| en-greeting | greeting | Bonjour, docteur. | ok | 245 |
| en-conversation | conversation | Comment te sens-tu aujourd'hui? | ok | 449 |
| en-numbers | numbers | Le projet de loi est de 15 000 shillings pendant trois jours. | ok | 665 |
| en-dates | dates | Votre rendez-vous est le 12 mars 2026. | ok | 475 |
| en-names | names | Appelez l'infirmière Amina dans la chambre 4. | ok | 450 |
| en-clinic | clinic | Je prends ce médicament depuis cinq jours, mais la douleur n'a pas cessé. | ok | 769 |
| en-symptoms | symptoms | Ma poitrine est lourde et je suis à court de souffle. | ok | 521 |
| en-medication | medication | Prenez un comprimé de paracetamol 500 mg deux fois par jour après les repas. | ok | 790 |
| en-hotel | hotel | Je voudrais réserver une chambre double pour deux nuits avec petit déjeuner inclus. | ok | 625 |
| en-office | office | La séance est lundi, veuillez me faire parvenir le rapport avant. | ok | 610 |
| en-question | question | Vous comprenez ce que je dis? | ok | 385 |
| en-negation | negation | Je ne suis pas autorisé à manger avec du sel. | ok | 525 |
| en-instruction | instruction | Ouvrez la bouche et respirez profondément. | ok | 372 |
| en-clinic-2 | clinic | Le médecin vous verra après que l'infirmière ait vérifié votre tension artérielle. | ok | 683 |

## French -> English — local-mt-hf

Runtime: transformers.js + ONNX Runtime, q8 (cached locally)  |  License: Helsinki-NLP/opus-mt-fr-en = Apache-2.0  |  Warmup: 1728ms
Clean: **14/14**  |  empty 0  repetition 0  source-copy 0  preserve-misses 0  errors 0  |  mean latency **504ms**

| id | category | output | flags | ms |
|---|---|---|---|---|
| fr-greeting | greeting | Hello, doctor. | ok | 210 |
| fr-conversation | conversation | How are you feeling today? | ok | 289 |
| fr-numbers | numbers | The bill is 15,000 shillings for three days. | ok | 542 |
| fr-dates | dates | Your appointment is on March 12, 2026. | ok | 418 |
| fr-names | names | Please call Nurse Amina in room four. | ok | 426 |
| fr-clinic | clinic | I've been taking this medication for five days, but the pain hasn't stopped. | ok | 939 |
| fr-symptoms | symptoms | I have a heavy chest and I have difficulty breathing. | ok | 493 |
| fr-medication | medication | Take one tablet of paracetamol 500 mg twice daily after meals. | ok | 654 |
| fr-hotel | hotel | I would like to reserve a double room for two nights with breakfast included. | ok | 660 |
| fr-office | office | The meeting is Monday, please send me the report before. | ok | 589 |
| fr-question | question | Do you understand what I'm saying? | ok | 417 |
| fr-negation | negation | I am not allowed to eat foods containing salt. | ok | 450 |
| fr-instruction | instruction | Open your mouth and breathe deeply. | ok | 329 |
| fr-clinic-2 | clinic | The doctor will see you after the nurse takes your blood pressure. | ok | 644 |
