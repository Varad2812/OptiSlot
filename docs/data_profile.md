# Data profile — `Sample_IO_MDB_VIT_v2_1.xlsx`

- Sheet `MDB-1`: **190 rows × 143 columns**
- Live rows (status ≠ DELETED): **189**
- Distinct tag keys: 190 (duplicates: 0)

## Status

| status | count |
|---|---|
| `New` | 157 |
| `Modified` | 32 |
| `DELETED` | 1 |

## IO types (raw)

| io | count |
|---|---|
| `AI` | 47 |
| `DIR` | 39 |
| `AIR` | 29 |
| `DOR` | 27 |
| `DO` | 14 |
| `AO` | 12 |
| `AOR` | 12 |
| `DI` | 10 |

## Signal types

| sig | count |
|---|---|
| `-` | 90 |
| `4-20 ma HART` | 83 |
| `4-20 ma` | 13 |
| `RTD` | 4 |

## Signal levels

| level | count |
|---|---|
| `2-Wire` | 90 |
| `Voltfree-contact` | 49 |
| `Volt-contact` | 41 |
| `4-Wire` | 6 |
| `3-Wire` | 4 |

## Rooms

| room | count |
|---|---|
| `PIB-30` | 144 |
| `PIB-24` | 46 |

## Design areas

| area | count |
|---|---|
| `RA 320-01` | 144 |
| `RA 500-02` | 46 |

## Cable specs

| cable_spec | count |
|---|---|
| `24PX1MM2/FR/IND&OS/ARM/NIS` | 110 |
| `24PX2.5MM2/FR/ARM/NIS` | 31 |
| `12PX1MM2/FR/IND&OS/ARM/NIS` | 20 |
| `-` | 9 |
| `06PX1MM2/FR/IND&OS/ARM/NIS` | 8 |
| `12PX2.5MM2/FR/ARM/NIS` | 5 |
| `06PX2.5MM2/FR/ARM/NIS` | 4 |
| `2PX1.3MM2/FR/IND&OS/NIS` | 2 |
| `1TX1.3MM2/FR/OS/NIS` | 1 |

## IO Grouping / segregation

| group | count |
|---|---|
| `-` | 141 |
| `A` | 22 |
| `B` | 15 |
| `A-CONTROL` | 5 |
| `B-ALARM` | 3 |
| `C` | 2 |
| `E` | 2 |

## Instrument types per IO type

| IO type | instrument types |
|---|---|
| `AI` | TT×13, PT×12, LT×8, PDT×6, FT×3, XPT×3, ZPT×2 |
| `AIR` | FT×8, TT×7, PT×6, EJA×4, LT×2, PZT×2 |
| `AO` | LI×3, PI×3, FI×2, QI×2, TI×2 |
| `AOR` | FV×6, PV×5, LV×1 |
| `DI` | XLS×2, ZLS×2, EJA×2, AXS×1, TAQ×1, EJR×1, DXLS×1 |
| `DIR` | XLS×22, EJA×8, HS×4, XS×3, XHSC×1, XHSO×1 |
| `DO` | XA×5, ZLO×4, MHL×2, MXL×1, QAX×1, MXA×1 |
| `DOR` | XYV×19, ZYV×8 |

## Cables

| cable | spec | size | used pairs | max pair | families | IO types | groups |
|---|---|---|---|---|---|---|---|
| `320-CE-0001` | 24PX1MM2/FR/IND&OS/ARM/NIS | 24.0 | 18 | 20.0 | A | AI,AIR,AOR,DIR | -,A,A-CONTROL |
| `320-CE-0004` | 24PX1MM2/FR/IND&OS/ARM/NIS | 24.0 | 19 | 19.0 | B | AI,AIR,AOR,DIR | -,B,B-ALARM |
| `320-CE-0035` | 06PX1MM2/FR/IND&OS/ARM/NIS | 6.0 | 4 | 4.0 | A | AI,AIR | -,A |
| `320-CE-0040` | 24PX1MM2/FR/IND&OS/ARM/NIS | 24.0 | 19 | 19.0 | A | AI,AIR,DIR | -,A |
| `320-CE-0045` | 12PX1MM2/FR/IND&OS/ARM/NIS | 12.0 | 9 | 10.0 | B | AI,DI,DIR | -,B |
| `320-CE-0083` | 24PX1MM2/FR/IND&OS/ARM/NIS | 24.0 | 19 | 19.0 | B | AI,AOR,DI,DIR | -,B-ALARM |
| `320-CE-0087` | 24PX1MM2/FR/IND&OS/ARM/NIS | 24.0 | 19 | 19.0 | A | AI,AIR,AOR,DI | -,A-CONTROL |
| `320-CS-0005` | 12PX2.5MM2/FR/ARM/NIS | 12.0 | 5 | 6.0 | B | DOR | -,B |
| `320-CS-0008` | 24PX2.5MM2/FR/ARM/NIS | 24.0 | 18 | 18.0 | A | DOR | -,A,C,E |
| `320-CS-0022` | 06PX2.5MM2/FR/ARM/NIS | 6.0 | 4 | 4.0 | - | DOR | - |
| `500-CE-0013` | 06PX1MM2/FR/IND&OS/ARM/NIS | 6.0 | 4 | 4.0 | - | AI,AO | - |
| `500-CE-0015` | 12PX1MM2/FR/IND&OS/ARM/NIS | 12.0 | 5 | 5.0 | - | AI,DIR | - |
| `500-CE-LP-0003-A` | 24PX1MM2/FR/IND&OS/ARM/NIS | 24.0 | 15 | 19.0 | - | AO,DIR,DO | - |
| `500-CE-LP-0003-B` | 24PX2.5MM2/FR/ARM/NIS | 24.0 | 13 | 18.0 | - | DO | - |
| `OS02-ICE-6001` | 12PX1MM2/FR/IND&OS/ARM/NIS | 12.0 | 6 | 6.0 | - | AI,DI | - |
| `Internal Wiring` | - | nan | 9 | nan | - | AIR,DIR | - |
| `P30-ICE-0001` | 1TX1.3MM2/FR/OS/NIS | 1.0 | 1 | 1.0 | - | AIR | - |
| `P30-ICE-0002` | 2PX1.3MM2/FR/IND&OS/NIS | 2.0 | 2 | 2.0 | - | DIR | - |

## Findings for pre-flight

- Cables with BOTH A and B family signals: none
- Live rows missing cable or pair: 0 (excel rows [])
- Duplicate cable+pair: 0 []
- Pair number > cable size: 0
- Cabinet-alarm candidates (internal wiring or equipment = cabinet): 12 → equipment ['P24-DCM-50002-01', 'P30-DCM-32001-01', 'P30-DCM-32001-04', 'P30-DCS-32001-01']
- DELETED rows: ['320-FT   -80002']
- DO rows with instrument type outside the default hardware lists: 0
- Controller domains (room, area) → cables: PIB-30 / RA 320-01: 13 cables; PIB-24 / RA 500-02: 6 cables
