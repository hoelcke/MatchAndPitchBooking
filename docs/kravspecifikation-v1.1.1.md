# Kravspecifikation: Matchbörsen & Planbokning för Träningsmatcher

**Dokumentversion:** 1.1.1 (ersätter 1.0.0)  
**Status:** Utkast för granskning. De 34 besluten från granskningen är inarbetade (se bilaga A), liksom förtydligandena efter kravanalytikerns granskning (se bilaga B). Punkter markerade **[FÖRSLAG]** är inte beslutade.  
**Målgrupp:** Utvecklare, AI-assistenter (Claude Code), produktägare, föreningsadministratörer  
**Arkitekturstil:** Event-driven domändesign med separation of concerns (intern outbox, se avsnitt 4.0)  
**Omfattning:** MVP 1, en klubb (IFK Lidingö)

---

## 0. Ändringar sedan v1.0

De viktigaste ändringarna. Fullständig spårbarhet finns i bilaga A.

- Avvikelseflödena är kompletta: kansliet kan avslå och ställa in, 14-dagarsregeln är automatisk, matcher kan gå till `EXPIRED`, och avbokning är möjlig redan i `RESERVATION_REQUESTED`.
- Tre nya events: `RESERVATION_REJECTED`, `RESERVATION_CANCELLED_BY_OFFICE` och `MATCH_EXPIRED`. `MATCH_COMPLETED` utlöses nu av hemmalagets bekräftelse, inte av klockan.
- Ny datamodell: `User`, `Team`, `TeamMembership`, `Inquiry`, `Facility` och `Pitch`. `ageGroup` är ersatt av `birthYear` och `category`, nivåskalan har sex steg och Fair Play är tre delbetyg 1–3.
- MVP:n är avgränsad till IFK Lidingö. Inloggning sker med Google Identity Services, och rollerna är gäst, lagledare, kansli och administratör.
- Alla tidpunkter lagras i UTC. Regler och frister räknas i `Europe/Stockholm`.
- Fair Play har ingen kommentar och ingen incidentflagga. Det recenserade laget ser aldrig enskilda recensioner.
- Geografifiltret är borttaget. Notifieringar skickas bara som e-post.
- Dokumentet är ren markdown utan escape-tecken, och diagram ligger i kodblock.

**Ändringar i 1.1.1 (efter granskning av en kravanalytiker):**

- Minsta ledtid för Spår 1 är 21 dagar i stället för 14 (BR-06).
- Hemmalaget får påminnelser om att bekräfta "Match genomförd" (AC-107.3).
- Telefonnummer lagras bara i `LeaderContact`, inte i `User`.
- Kansliet kan ställa in en bokning i både `RESERVED` och `ACCEPTED` (B10, AC-206.1).
- `MATCH_EXPIRED` är beslutad och reservationsstatusen `CLOSED_UNCONFIRMED` är omdöpt till `CLOSED_EXPIRED`.
- Medianberäkningen är formaliserad (BR-13), en transaktionsregel mot samtidiga ändringar är tillagd (BR-16) och `reservationId` är valfritt i `MATCH_COMPLETED`.
- Ett lag vars intresseanmälan avvisats kan skapa en ny anmälan när matchen återgår till börsen.

---

## 1. Systemöversikt & Målbild

Systemet digitaliserar och automatiserar administrationen av träningsmatcher för ungdomslag inom fotboll. Det löser tre kärnproblem:

1. **Resursallokering:** Effektiviserar helgbokning av planer via IFK Lidingös kansli enligt föreningens regler.
2. **Matchning:** En central Matchbörs för att hitta motståndare på likvärdig nivå, med stöd för både nysökta helgtider (Spår 1) och egna ordinarie träningstider (Spår 2).
3. **Klimat & kvalitetssäkring:** Ömsesidig, oberoende Fair Play-utvärdering efter genomförd match.

### 1.1 Domänarkitektur & Ansvarsfördelning

Systemet är uppdelat i tre självständiga domäner/processer:

| Process | Domän | Primär aktör | Ansvar |
| :---- | :---- | :---- | :---- |
| **Process A** | Matchgenomförande | Lagledare (IFK Lidingö) | Skapa match, publicera på börsen, välja motståndare, hantera avbokning och återbud, bekräfta att matchen genomförts. |
| **Process B** | Planbokning | Kanslipersonal (IFK Lidingö) | Underhålla anläggningar och planer, tilldela eller avslå helgplaner, ställa in bokningar, 14-dagarsregeln. |
| **Process C** | Fair Play-recension | Lagledare (båda lagen) | Oberoende, parallell utvärdering av matchklimat och lagets nivå. |

### 1.2 Flödesöversikt

```
PROCESS A: MATCHGENOMFÖRANDE        PROCESS B: PLANBOKNING            PROCESS C: FAIR PLAY
(Lagledare)                         (IFK Lidingös kansli)             (Två parallella instanser)

(1) Skapa match
    Spår 1: sök ny helgtid ───────► REQUEST_RESERVATION ────────────► REQUESTED
                                    kansliet tilldelar plan  ───────► RESERVED
            ◄── RESERVATION_RESERVED ───────────────────────────────┘
            ◄── RESERVATION_REJECTED (kansliet avslår) ─────────────► match: CANCELLED
    Spår 2: egen tid, plan väljs ur masterdata (Process B startas inte)

(2) PUBLISHED på Matchbörsen
    (intresseanmälningar tas emot löpande)
    Ingen motståndare vid starttid ─────────────────────────────────► match: EXPIRED

(3) Hemmalaget väljer motståndare ─► MATCH_CONFIRMED
    ── RESERVATION_ACCEPTED ───────► ACCEPTED   (Spår 1; skickas om vid ny motståndare)

    [Återbud från valt lag]  ► tillbaka till PUBLISHED, isUrgent = true
                               (Process B meddelas inte, plantiden behålls)
    [Hemmalaget avbokar]     ── RESERVATION_WITHDRAWN ──► plantiden frigörs
    [14 dagar passerat utan accept] ◄─ RESERVATION_REVOKED ─ (automatiskt) ► match: CANCELLED
    [Kansliet ställer in]    ◄─ RESERVATION_CANCELLED_BY_OFFICE ──────────► match: CANCELLED

(4) Hemmalaget bekräftar "Match genomförd" (inom 48 h efter sluttid)
    ── MATCH_COMPLETED ────────────► COMPLETED                      ┬────► [C1: hemmalag recenserar]
                                                                      └────► [C2: bortalag recenserar]
    Ingen bekräftelse inom 48 h ► match: EXPIRED, MATCH_EXPIRED till B, inga recensioner

(5) Process C: båda inlämnade eller 7 dagar gått ► recensionerna räknas in i lagprofilerna
```

### 1.3 Avgränsning av MVP 1: en klubb

- Endast lag som tillhör IFK Lidingö kan initiera en träningsmatchbokning (Spår 1 och Spår 2).
- IFK Lidingös kansli står för all planbokning.
- Matchbörsen är öppen för externa lag att anmäla intresse.
- Flera klubbar med egna kansli och egna anläggningar (multi-tenant) skjuts till en senare version.

### 1.4 Tid och tidszon

- Alla tidpunkter lagras och skickas i events som UTC (ISO-8601 med `Z`).
- Alla regler och frister räknas i `Europe/Stockholm`, inklusive sommartid. Det gäller 14-dagarsfristen (kl 23:59:59), 48-timmarsfristen och 7-dagarsfristen.
- Visning i gränssnittet sker i `Europe/Stockholm`.
- `requestedDate` och `timeWindow` i en reservationsbegäran är lokala värden.
- Exempel: lördag 2026-10-24, lokal tid 10:00–11:30 (CEST, UTC+2), lagras som `2026-10-24T08:00:00Z` till `2026-10-24T09:30:00Z`. Fristen 14 dagar före (2026-10-10 kl 23:59:59 lokal tid) lagras som `2026-10-10T21:59:59Z`.

### 1.5 Roller

| Roll | Konto | Behörighet |
| :---- | :---- | :---- |
| **Gäst** | Nej | Se matcher med status `PUBLISHED` på börsen, utan kontaktuppgifter. Kan inte anmäla intresse. |
| **Lagledare, externt lag** | Ja | Skapa lagprofil, anmäla och dra tillbaka intresse, lämna återbud när laget valts, skicka Fair Play-recension. |
| **Lagledare, IFK Lidingö** | Ja | Som externt lag, och efter att kansliet godkänt kopplingen ledare–lag: skapa matcher (Spår 1 och 2), välja motståndare, avboka, bekräfta "Match genomförd". Före godkännande gäller gästens rättigheter plus att skapa lagprofil. |
| **Kansli (IFK Lidingö)** | Ja | Hantera reservationsförfrågningar, underhålla anläggningar och planer, godkänna eller avslå IFK Lidingö-lag och ledarkopplingar. |
| **Administratör** | Ja | Läsa enskilda Fair Play-recensioner. **[FÖRSLAG]** Hantera raderingsbegäranden. |

### 1.6 Autentisering

- Alla användare med konto (lagledare, kansli, administratör) loggar in med Google Identity Services.
- Varje lagledare är kopplad till en lagprofil (se `TeamMembership`).
- Gäster behöver ingen inloggning och kan bara se börsen.
- Alternativ för användare utan Google-konto och hur roller testas utan många Google-konton är inte beslutat (se avsnitt 10).

---

## 2. Domänmodeller & Typer (TypeScript Definitioner)

Alla tidsfält av typen `string` i detta avsnitt är ISO-8601 i UTC (`Z`) om inget annat anges.

```ts
export type MatchOrigin = 'NEW_WEEKEND_SLOT' | 'OWN_TRAINING_SLOT'; // Spår 1 | Spår 2

export type GameFormat = '3v3' | '5v5' | '7v7_SMALL' | '7v7_LARGE' | '9v9' | '11v11';

export type TeamCategory = 'BOYS' | 'GIRLS' | 'MIXED';

// Gemensam sexgradig skala. Används för matchnivå (nivån på motståndet)
// och för lagets bedömda nivå (motståndarens bedömning i review).
export type Level =
  | 'EASY'         // Lätt
  | 'EASY_PLUS'    // Lätt plus
  | 'MEDIUM'       // Medel
  | 'MEDIUM_PLUS'  // Medel plus
  | 'HARD'         // Svår
  | 'HARD_PLUS';   // Svår plus

export type RefereeArrangement = 'HOME_ARRANGES' | 'AWAY_BRINGS' | 'SHARED_ON_SITE';

export type Surface = 'ARTIFICIAL_TURF' | 'NATURAL_TURF';

export type UserRole = 'TEAM_LEADER' | 'OFFICE' | 'ADMIN'; // Gäst har inget konto

export type ApprovalStatus =
  | 'NOT_REQUIRED' // Externa lag
  | 'PENDING'      // IFK Lidingö-koppling väntar på kansliets beslut
  | 'APPROVED'
  | 'REJECTED';

export type MatchStatus =
  | 'RESERVATION_REQUESTED' // Endast Spår 1
  | 'PUBLISHED'             // Sökbar på börsen
  | 'MATCH_CONFIRMED'       // Motståndare vald (utan eget accepterande)
  | 'COMPLETED'             // Hemmalaget har bekräftat "Match genomförd"
  | 'CANCELLED'             // Aktiv avbokning, avslag, återkallelse eller inställning
  | 'EXPIRED';              // Tiden gick ut utan resultat (ingen motståndare, eller ej bekräftad)

export type ReservationStatus =
  | 'REQUESTED'             // Begärd, väntar på kansliet
  | 'RESERVED'              // Plan tilldelad (preliminär)
  | 'ACCEPTED'              // Motståndare vald, bokningen låst
  | 'COMPLETED'             // Matchen genomförd
  | 'REJECTED_BY_OFFICE'    // Kansliet avslog förfrågan
  | 'REVOKED_BY_DEADLINE'   // Systemet återkallade efter 14-dagarsfristen (tidigare REVOKED_BY_OFFICE)
  | 'CANCELLED_BY_OFFICE'   // Kansliet ställde in en reserverad eller accepterad bokning
  | 'WITHDRAWN_BY_HOME'     // Hemmalaget avbokade
  | 'CLOSED_EXPIRED';       // Match utgick (ej bekräftad inom 48 h, eller ingen motståndare vid starttid)

export type InquiryStatus = 'ACTIVE' | 'WITHDRAWN' | 'SELECTED' | 'REJECTED';

export type ReviewStatus = 'PENDING' | 'SUBMITTED' | 'EXPIRED' | 'PUBLISHED';

export interface User {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  googleSubject: string;
  createdAt: string;
}
// Endast myndiga ledare och kanslipersonal registreras. Inga uppgifter om minderåriga.
// Telefonnummer lagras inte på användaren (se LeaderContact).

export interface TeamProfile {
  assessedLevel?: Level;      // Median av bedömd nivå, senaste 10 recensionerna
  fairPlayAverage?: number;   // Genomsnitt av recensionernas totalbetyg (1–3), senaste 10
  reviewCount: number;        // Antal recensioner i fönstret (max 10)
  visible: boolean;           // true först när reviewCount >= 3
}

export interface Team {
  id: string;
  name: string;
  clubName: string;
  isHomeClub: boolean;        // true = IFK Lidingö
  birthYear: number;          // T.ex. 2015
  category: TeamCategory;
  profile: TeamProfile;
}

export interface TeamMembership {
  id: string;
  userId: string;
  teamId: string;
  approvalStatus: ApprovalStatus; // Godkännandet gäller kopplingen ledare–lag
  decidedByUserId?: string;
  decidedAt?: string;
  createdAt: string;
}

// Kopia på matchkort och intresseanmälan. Anonymiseras vid radering av användaren.
// Telefonnumret anges av ledaren när match eller intresseanmälan skapas och lagras bara här.
export interface LeaderContact {
  userId: string;
  name: string;
  club: string;
  teamName: string;
  email: string;
  phone: string;
}

export interface Facility {
  id: string;
  name: string;               // T.ex. "Skärsätra IP"
  address: string;
  active: boolean;
}

export interface Pitch {
  id: string;
  facilityId: string;
  name: string;               // T.ex. "Plan 2"
  surface: Surface;
  supportedFormats: GameFormat[];
  active: boolean;
}

export interface MatchEntity {
  id: string;
  origin: MatchOrigin;
  homeTeamId: string;
  homeContact: LeaderContact;
  awayTeamId?: string;        // Satt när motståndare är vald
  selectedOpponent?: LeaderContact;
  gameFormat: GameFormat;
  birthYear: number;
  category: TeamCategory;
  openToAdjacentBirthYears: boolean; // true = öppen för ett år yngre eller äldre
  matchLevel: Level;          // Nivån på motståndet
  durationMinutes: number;    // T.ex. 60 (3x20)
  venue: {
    facilityId: string;
    pitchId: string;
    facilityName: string;
    facilityAddress: string;
    pitchName: string;
    surface: Surface;
    startTime: string;
    endTime: string;
  };
  referee: RefereeArrangement;
  kitColorHome: string;
  status: MatchStatus;
  reservationId?: string;     // Koppling till Process B om Spår 1
  inquiriesCount: number;     // Antal ACTIVE intresseanmälningar
  isUrgent: boolean;          // true efter återbud; false när ny motståndare bekräftas
  completedConfirmedAt?: string; // När hemmalaget bekräftade "Match genomförd"
  createdAt: string;
  updatedAt: string;
}

export interface InquiryEntity {
  id: string;
  matchId: string;
  teamId: string;
  leaderUserId: string;
  contact: LeaderContact;
  status: InquiryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationEntity {
  id: string;
  matchId: string;
  homeTeamId: string;
  requestedDate: string;      // YYYY-MM-DD, lokalt datum, endast lördag/söndag
  timeWindow: string;         // Lokal tid, t.ex. "10:00-13:00"
  gameFormat: GameFormat;
  birthYear: number;
  category: TeamCategory;
  allocatedPitch?: {
    facilityId: string;
    pitchId: string;
    facilityName: string;
    pitchName: string;
    startTime: string;
    endTime: string;
  };
  opponent?: {                // Från senaste RESERVATION_ACCEPTED, skrivs över vid ny motståndare
    club: string;
    teamName: string;
    contactName: string;
    contactPhone: string;
  };
  status: ReservationStatus;
  decisionReason?: string;    // Obligatorisk vid REJECTED_BY_OFFICE och CANCELLED_BY_OFFICE
  deadlineAt: string;         // Matchdatum minus 14 dagar kl 23:59:59 Europe/Stockholm, i UTC
  createdAt: string;
  updatedAt: string;
}

export interface FairPlayReviewEntity {
  id: string;
  matchId: string;
  reviewingTeamId: string;
  reviewedTeamId: string;
  targetRole: 'HOME' | 'AWAY';
  playersScore?: 1 | 2 | 3;
  leadersScore?: 1 | 2 | 3;
  spectatorsScore?: 1 | 2 | 3 | 'NOT_APPLICABLE';
  totalScore?: number;        // Genomsnitt av delbetygen; 'NOT_APPLICABLE' räknas inte med
  assessedLevel?: Level;      // Reviewerns bedömning av det recenserade lagets nivå
  status: ReviewStatus;
  deadlineAt: string;         // 7 dagar efter MATCH_COMPLETED (räknat i Europe/Stockholm)
  submittedAt?: string;
}
// Ingen fritextkommentar och ingen incidentflagga i MVP 1.

export interface AuditLogEntry {
  id: string;
  eventId: string;
  userId: string;             // Pseudonymt användar-ID. Inga namn, e-post eller telefon.
  entityType: string;
  entityId: string;
  transition: string;
  occurredAt: string;
}

export interface OutboxEvent {
  eventId: string;
  eventType: string;
  matchId: string;
  sequence: number;           // Strikt stigande per matchId
  payload: unknown;
  createdAt: string;
  processedAt?: string;
}
```

---

## 3. Tillståndsmaskiner (FSM) per domän

Statusövergångar som inte finns i matriserna är otillåtna. Händelser som tas emot i ett läge där de inte längre är relevanta ignoreras och loggas i audit-loggen (se 4.0).

### 3.1 Process A: Matchgenomförande (`MatchStatus`)

```
 [Start: Spår 1]                                   [Start: Spår 2]
        │                                                 │
        ▼                                                 │
 RESERVATION_REQUESTED ──(RESERVATION_REJECTED)──► CANCELLED
        │  RESERVATION_RESERVED                           │
        ▼                                                 ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                          PUBLISHED                           │──(starttid passerad,
 └──────────────┬─────────────────────────────────▲────────────┘   ingen motståndare)──► EXPIRED
   Hemmalaget godkänner                  Återbud från valt lag
   motståndare                           (isUrgent = true)
                ▼                                  │
 ┌─────────────────────────────────────────────────┴───────────┐
 │                       MATCH_CONFIRMED                        │──(48 h efter sluttid utan
 └──────────────────────────┬──────────────────────────────────┘   bekräftelse)──► EXPIRED
   Hemmalaget bekräftar "Match genomförd"
                            ▼
                        COMPLETED

 CANCELLED nås också vid: avbokning (RESERVATION_REQUESTED, PUBLISHED, MATCH_CONFIRMED),
 RESERVATION_REVOKED och RESERVATION_CANCELLED_BY_OFFICE.
```

| # | Från status | Trigger / händelse | Guard (villkor) | Till status | Sidoeffekter |
| :---- | :---- | :---- | :---- | :---- | :---- |
| A1 | (start) | Ledare skapar match, Spår 1 | Ledaren har `APPROVED` koppling till ett IFK Lidingö-lag; helgdag (BR-01); minst 21 dagar kvar (BR-06); obligatoriska fält ifyllda | `RESERVATION_REQUESTED` | `REQUEST_RESERVATION` skickas till B |
| A2 | (start) | Ledare skapar match, Spår 2 | Ledaren har `APPROVED` koppling; plan vald ur masterdata; start- och sluttid angivna | `PUBLISHED` | Process B startas inte. Ingen validering och ingen överlappsvarning (BR-02) |
| A3 | `RESERVATION_REQUESTED` | `RESERVATION_RESERVED` mottas | – | `PUBLISHED` | Plan och tid uppdateras på matchen. Matchen blir synlig på börsen |
| A4 | `RESERVATION_REQUESTED` | `RESERVATION_REJECTED` mottas | – | `CANCELLED` | Hemmalaget notifieras med kansliets orsak |
| A5 | `RESERVATION_REQUESTED` | Hemmalaget avbokar | – | `CANCELLED` | `RESERVATION_WITHDRAWN` skickas till B |
| A6 | `PUBLISHED` | Hemmalaget godkänner motståndare | Minst en `ACTIVE` intresseanmälan; laget matchar (BR-09) | `MATCH_CONFIRMED` | Vald anmälan blir `SELECTED`. Övriga `ACTIVE` anmälningar blir `REJECTED` och lagen notifieras. `awayTeamId` och `selectedOpponent` sätts. `isUrgent = false`. Spår 1: `RESERVATION_ACCEPTED` skickas till B. Kontaktuppgifter blir synliga för båda parter |
| A7 | `MATCH_CONFIRMED` | Valt lag lämnar återbud | Starttid ej passerad | `PUBLISHED` | `isUrgent = true`. `awayTeamId` och `selectedOpponent` rensas. Vald anmälan blir `WITHDRAWN`. Hemmalaget notifieras. Inget event till B (BR-04) |
| A8 | `PUBLISHED` | Hemmalaget avbokar | Starttid ej passerad | `CANCELLED` | Spår 1: `RESERVATION_WITHDRAWN` till B. `ACTIVE` anmälningar notifieras |
| A9 | `MATCH_CONFIRMED` | Hemmalaget avbokar | Starttid ej passerad | `CANCELLED` | Spår 1: `RESERVATION_WITHDRAWN` till B. Valt lag notifieras |
| A10 | `PUBLISHED` | `RESERVATION_REVOKED` mottas | Spår 1 | `CANCELLED` | Hemmalaget och `ACTIVE` anmälningar notifieras |
| A11 | `PUBLISHED`, `MATCH_CONFIRMED` | `RESERVATION_CANCELLED_BY_OFFICE` mottas | Spår 1 | `CANCELLED` | Hemmalaget, valt lag (om valt) och `ACTIVE` sökande notifieras, med kansliets orsak |
| A12 | `PUBLISHED` | Starttid passerad | Ingen motståndare vald | `EXPIRED` | Matchen lämnar börsen. Spår 1 med `ACCEPTED` reservation: `MATCH_EXPIRED` till B |
| A13 | `MATCH_CONFIRMED` | Hemmalaget bekräftar "Match genomförd" | Sluttid passerad och högst 48 h efter sluttid | `COMPLETED` | `MATCH_COMPLETED` skickas till B (Spår 1) och C |
| A14 | `MATCH_CONFIRMED` | 48 h efter sluttid utan bekräftelse | – | `EXPIRED` | Inga recensioner skapas. Spår 1: `MATCH_EXPIRED` till B |

Slutlägen är `COMPLETED`, `CANCELLED` och `EXPIRED`. `CANCELLED` betyder att något aktivt avbröt matchen. `EXPIRED` betyder att tiden gick ut utan resultat (BR-11).

### 3.2 Process B: Planbokning (`ReservationStatus`)

```
 REQUESTED ──(kansliet avslår, orsak)──────────────► REJECTED_BY_OFFICE
     │
     │ kansliet tilldelar plan
     ▼
 RESERVED ──(14-dagarsfrist passerad, automatiskt)──► REVOKED_BY_DEADLINE
     │ ──(kansliet ställer in, orsak)────────────► CANCELLED_BY_OFFICE
     │
     │ RESERVATION_ACCEPTED
     ▼
 ACCEPTED ◄──┐ RESERVATION_ACCEPTED igen (ny motståndare efter återbud):
     │       │ motståndarinfo skrivs över, ingen statusändring
     ├───────┘
     ├── MATCH_COMPLETED ─────────────────────────► COMPLETED
     ├── MATCH_EXPIRED ───────────────────────────► CLOSED_EXPIRED
     └── kansliet ställer in (orsak) ─────────────► CANCELLED_BY_OFFICE

 RESERVATION_WITHDRAWN från REQUESTED, RESERVED eller ACCEPTED ─► WITHDRAWN_BY_HOME
 (plantiden frigörs direkt)
```

| # | Från status | Trigger / händelse | Guard (villkor) | Till status | Sidoeffekter |
| :---- | :---- | :---- | :---- | :---- | :---- |
| B1 | (start) | `REQUEST_RESERVATION` mottas | – | `REQUESTED` | Ärende hamnar i kansliets kö |
| B2 | `REQUESTED` | Kansliet tilldelar plan | Planen stödjer spelformen. Överlapp på samma plan och tid ger varning men får åsidosättas. Ärendet är inte `WITHDRAWN_BY_HOME` | `RESERVED` | `RESERVATION_RESERVED` skickas till A |
| B3 | `REQUESTED` | Kansliet avslår | Orsak obligatorisk | `REJECTED_BY_OFFICE` | `RESERVATION_REJECTED` skickas till A |
| B4 | `REQUESTED` | `RESERVATION_WITHDRAWN` mottas | – | `WITHDRAWN_BY_HOME` | Ärendet visas som avbokat och kan inte tilldelas |
| B5 | `RESERVED` | `RESERVATION_ACCEPTED` mottas | – | `ACCEPTED` | Motståndarinfo sparas. Bokningen låses |
| B6 | `RESERVED` | `RESERVATION_WITHDRAWN` mottas | – | `WITHDRAWN_BY_HOME` | Plantiden frigörs direkt |
| B7 | `RESERVED` | Frist: matchdatum minus 14 dagar kl 23:59:59 `Europe/Stockholm` | Inget `RESERVATION_ACCEPTED` mottaget | `REVOKED_BY_DEADLINE` | Automatiskt. Plantiden frigörs. `RESERVATION_REVOKED` (`DEADLINE_EXPIRED_14_DAYS`) skickas till A |
| B8 | `ACCEPTED` | `RESERVATION_ACCEPTED` mottas | Ny motståndare efter återbud | `ACCEPTED` | Motståndarinfo skrivs över |
| B9 | `ACCEPTED` | `RESERVATION_WITHDRAWN` mottas | – | `WITHDRAWN_BY_HOME` | Plantiden frigörs |
| B10 | `RESERVED`, `ACCEPTED` | Kansliet ställer in | Orsak obligatorisk | `CANCELLED_BY_OFFICE` | Plantiden frigörs. `RESERVATION_CANCELLED_BY_OFFICE` skickas till A |
| B11 | `ACCEPTED` | `MATCH_COMPLETED` mottas | – | `COMPLETED` | Arkiveras |
| B12 | `ACCEPTED` | `MATCH_EXPIRED` mottas | – | `CLOSED_EXPIRED` | Plantiden frigörs. Arkiveras |

**Kappslöpning vid avbokning:** Hemmalaget avbokar medan kansliet tilldelar plan. Båda händelserna ordnas per `matchId` (4.0). Process A är då redan `CANCELLED` och ignorerar ett sent `RESERVATION_RESERVED`. Process B frigör planen direkt när `RESERVATION_WITHDRAWN` behandlas. Ett ärende som redan är `WITHDRAWN_BY_HOME` kan inte tilldelas i kansliets gränssnitt.

### 3.3 Process C: Fair Play-recension (`ReviewStatus`, per instans)

```
 [MATCH_COMPLETED] ──► två instanser, båda PENDING
                        C1: hemmalaget recenserar bortalaget
                        C2: bortalaget recenserar hemmalaget

 PENDING ──(formulär inskickat)──► SUBMITTED   (dold för alla utom administratören)

 Båda SUBMITTED ──────────────────► båda PUBLISHED (räknas in i lagprofilerna samtidigt)

 Frist: 7 dagar från MATCH_COMPLETED
   en SUBMITTED  ──► den blir PUBLISHED, den andra EXPIRED
   ingen SUBMITTED ─► båda EXPIRED, inget räknas in
```

| # | Från status | Trigger / händelse | Guard (villkor) | Till status | Sidoeffekter |
| :---- | :---- | :---- | :---- | :---- | :---- |
| C1 | (start) | `MATCH_COMPLETED` mottas | – | `PENDING` (två instanser) | Båda ledare notifieras. `deadlineAt` = `MATCH_COMPLETED` plus 7 dagar |
| C2 | `PENDING` | Formulär skickas in | Delbetyg för spelare och ledare samt bedömd nivå angivna | `SUBMITTED` | Recensionen är dold |
| C3 | `SUBMITTED` | Motpartens instans blir `SUBMITTED` | – | `PUBLISHED` | Båda räknas in i respektive lagprofil. `REVIEW_AGGREGATED` skickas |
| C4 | `SUBMITTED` | Frist passerad | Motpartens instans är inte `SUBMITTED` | `PUBLISHED` | Räknas in i den recenserades lagprofil. `REVIEW_AGGREGATED` skickas |
| C5 | `PENDING` | Frist passerad | – | `EXPIRED` | Räknas inte in |

`PUBLISHED` betyder att recensionen räknas in i lagprofilen. Den visas aldrig för det recenserade laget (se FR-C-302).

---

## 4. Event-kontrakt

### 4.0 Leverans, ordning och idempotens

- **Intern outbox:** Varje tillståndsändring skriver nytt tillstånd och en rad i `OutboxEvent` i samma databastransaktion. Det finns ingen extern broker i MVP 1. Outbox-tabellen kan senare tömmas mot en broker utan att processerna ändras.
- **Idempotens:** Mottagaren behandlar varje `eventId` högst en gång.
- **Ordning:** `sequence` är strikt stigande per `matchId`. Mottagaren behandlar events för samma `matchId` i sekvensordning.
- **Irrelevanta events:** Ett event som inte längre passar mottagarens tillstånd ignoreras och loggas. Exempel: `RESERVATION_RESERVED` till en match som redan är `CANCELLED`.
- **Routing:** Ett event dirigeras bara till de processer det är adresserat till. `MATCH_COMPLETED` utan `reservationId` (Spår 2) dirigeras endast till Process C och läggs inte i Process B:s kö.
- **Transaktionssäkerhet:** Varje övergång kontrollerar förväntad nuvarande status i samma transaktion (BR-16).
- **Gemensamma fält i alla events:** `eventId`, `sequence`, `occurredAt` (UTC), `matchId`.

| Event | Från | Till | Utlösare |
| :---- | :---- | :---- | :---- |
| `REQUEST_RESERVATION` | A | B | Spår 1-match skapas |
| `RESERVATION_RESERVED` | B | A | Kansliet tilldelar plan |
| `RESERVATION_REJECTED` | B | A | Kansliet avslår förfrågan |
| `RESERVATION_ACCEPTED` | A | B | Hemmalaget väljer motståndare (skickas om vid ny motståndare) |
| `RESERVATION_WITHDRAWN` | A | B | Hemmalaget avbokar |
| `RESERVATION_REVOKED` | B | A | 14-dagarsfristen passerad utan accept (automatiskt) |
| `RESERVATION_CANCELLED_BY_OFFICE` | B | A | Kansliet ställer in en accepterad bokning |
| `MATCH_COMPLETED` | A | B, C | Hemmalaget bekräftar "Match genomförd" |
| `MATCH_EXPIRED` | A | B | Match utgår (avslutar reservationen) |
| `REVIEW_AGGREGATED` | C | Lagprofil (intern modul) | Recension räknas in |

### 4.1 `REQUEST_RESERVATION` (A till B)

```json
{
  "eventId": "evt_uuid_001",
  "sequence": 1,
  "occurredAt": "2026-10-01T09:12:00Z",
  "matchId": "mat_12345",
  "homeTeamId": "team_lidingo_p15",
  "clubName": "IFK Lidingö",
  "requestedDate": "2026-10-24",
  "preferredTimeWindow": "10:00-13:00",
  "timeZone": "Europe/Stockholm",
  "gameFormat": "7v7_LARGE",
  "birthYear": 2015,
  "category": "BOYS"
}
```

### 4.2 `RESERVATION_RESERVED` (B till A)

```json
{
  "eventId": "evt_uuid_002",
  "sequence": 2,
  "occurredAt": "2026-10-02T07:30:00Z",
  "matchId": "mat_12345",
  "reservationId": "res_98765",
  "facilityId": "fac_skarsatra",
  "pitchId": "pitch_skarsatra_2",
  "facilityName": "Skärsätra IP",
  "pitchName": "Plan 2",
  "startTime": "2026-10-24T08:00:00Z",
  "endTime": "2026-10-24T09:30:00Z",
  "deadlineAt": "2026-10-10T21:59:59Z"
}
```

### 4.3 `RESERVATION_REJECTED` (B till A)

```json
{
  "eventId": "evt_uuid_003",
  "sequence": 2,
  "occurredAt": "2026-10-02T07:30:00Z",
  "matchId": "mat_12345",
  "reservationId": "res_98765",
  "reason": "Inga lediga planer för 7v7 stor den helgen"
}
```

`reason` är obligatorisk text, högst 200 tecken.

### 4.4 `RESERVATION_ACCEPTED` (A till B)

```json
{
  "eventId": "evt_uuid_004",
  "sequence": 3,
  "occurredAt": "2026-10-05T18:40:00Z",
  "matchId": "mat_12345",
  "reservationId": "res_98765",
  "awayTeamId": "team_hammarby_p15_11",
  "opponent": {
    "club": "Hammarby IF",
    "teamName": "Hammarby P2015-11",
    "contactName": "Anna Lind",
    "contactPhone": "+46701234567"
  }
}
```

Kan skickas flera gånger för samma `reservationId` (ny motståndare efter återbud). Senaste värdet gäller.

### 4.5 `RESERVATION_WITHDRAWN` (A till B)

```json
{
  "eventId": "evt_uuid_005",
  "sequence": 4,
  "occurredAt": "2026-10-06T12:00:00Z",
  "matchId": "mat_12345",
  "reservationId": "res_98765"
}
```

Giltigt från `REQUESTED`, `RESERVED` och `ACCEPTED`.

### 4.6 `RESERVATION_REVOKED` (B till A)

```json
{
  "eventId": "evt_uuid_006",
  "sequence": 3,
  "occurredAt": "2026-10-10T22:00:00Z",
  "matchId": "mat_12345",
  "reservationId": "res_98765",
  "reason": "DEADLINE_EXPIRED_14_DAYS"
}
```

Skickas automatiskt av systemet direkt efter fristen.

### 4.7 `RESERVATION_CANCELLED_BY_OFFICE` (B till A)

Skickas när kansliet ställer in en reservation i `RESERVED` eller `ACCEPTED`.

```json
{
  "eventId": "evt_uuid_007",
  "sequence": 5,
  "occurredAt": "2026-10-23T19:15:00Z",
  "matchId": "mat_12345",
  "reservationId": "res_98765",
  "reason": "Planen stängd på grund av tjäle"
}
```

`reason` är obligatorisk text, högst 200 tecken.

### 4.8 `MATCH_COMPLETED` (A till B och C)

```json
{
  "eventId": "evt_uuid_008",
  "sequence": 6,
  "occurredAt": "2026-10-26T17:05:00Z",
  "matchId": "mat_12345",
  "reservationId": "res_98765",
  "homeTeamId": "team_lidingo_p15",
  "awayTeamId": "team_hammarby_p15_11",
  "startTime": "2026-10-24T08:00:00Z",
  "endTime": "2026-10-24T09:30:00Z",
  "completedConfirmedAt": "2026-10-26T17:05:00Z",
  "reviewDeadlineAt": "2026-11-02T17:05:00Z"
}
```

`reservationId` är valfritt (`reservationId?: string`) och saknas för Spår 2. Eventet dirigeras då bara till Process C och läggs inte i Process B:s kö. `reviewDeadlineAt` är `completedConfirmedAt` plus 7 dagar, räknat i `Europe/Stockholm`.

### 4.9 `MATCH_EXPIRED` (A till B)

```json
{
  "eventId": "evt_uuid_009",
  "sequence": 6,
  "occurredAt": "2026-10-26T09:30:01Z",
  "matchId": "mat_12345",
  "reservationId": "res_98765",
  "reason": "NOT_CONFIRMED_WITHIN_48H"
}
```

`reason` är `NOT_CONFIRMED_WITHIN_48H` eller `NO_OPPONENT_AT_START`. Skickas bara när en Spår 1-reservation är `ACCEPTED`.

### 4.10 `REVIEW_AGGREGATED` (C till lagprofil)

```json
{
  "eventId": "evt_uuid_010",
  "sequence": 7,
  "occurredAt": "2026-11-02T17:05:01Z",
  "matchId": "mat_12345",
  "teamId": "team_hammarby_p15_11",
  "assessedLevel": "MEDIUM_PLUS",
  "fairPlayAverage": 2.7,
  "reviewCount": 10,
  "visible": true
}
```

Värdena är lagprofilens beräknade värden efter att recensionen räknats in, inte matchens enskilda betyg (se BR-13).

---

## 5. Affärsregler (Business Rules)

| ID | Regel | Beskrivning |
| :---- | :---- | :---- |
| **BR-01** | Endast helg för Spår 1 | Nya tider kan bara begäras för lördag och söndag. Vardagar nekas. |
| **BR-02** | Processisolering för Spår 2 | Ledare använder egna ordinarie träningstider. Ledaren väljer plan ur masterdata och anger tid själv. Ingen validering, ingen överlappsvarning och inga meddelanden till kansliet. |
| **BR-03** | 14-dagarsregeln (automatisk) | En motståndare måste vara vald (`RESERVATION_ACCEPTED` mottaget) senast 14 dagar före matchdatum kl 23:59:59 `Europe/Stockholm`. Annars återkallar systemet reservationen automatiskt, frigör plantiden och matchen blir `CANCELLED`. |
| **BR-04** | Autonom återbudshantering | Vid återbud från valt lag meddelas inte kansliet. Reservationen står kvar som `ACCEPTED`. När en ny motståndare väljs skickas `RESERVATION_ACCEPTED` igen och motståndarinfon skrivs över. 14-dagarsfristen räknas inte om. |
| **BR-05** | Blind review | Recensioner räknas in i lagprofilerna först när båda lagen lämnat in eller 7 dagar gått, så att båda räknas in samtidigt. Det recenserade laget ser aldrig enskilda recensioner, bara aggregerade värden på lagprofilen. |
| **BR-06** | Minsta ledtid för Spår 1 | Spår 1 kan bara begäras om matchdatumet ligger minst 21 dagar fram i tiden (datum räknat i `Europe/Stockholm`). Annars nekas begäran och ledaren hänvisas till Spår 2. Ledtiden ger kansliet och hemmalaget tid att hinna före 14-dagarsfristen (BR-03) och gör att 18-dagarspåminnelsen kan skickas. |
| **BR-07** | En klubb i MVP 1 | Endast lag som tillhör IFK Lidingö kan initiera en matchbokning. IFK Lidingös kansli står för planbokningen. Externa lag kan anmäla intresse. |
| **BR-08** | Godkännande av IFK Lidingö-ledare | En IFK Lidingö-ledares koppling till ett lag måste godkännas av kansliet (`APPROVED`) innan ledaren kan skapa matcher. Godkännandet gäller kopplingen ledare–lag, inte bara laget. Externa lag kräver inget godkännande. |
| **BR-09** | Matchkompatibilitet | Ett lag kan bara anmäla intresse om kategorin är densamma och födelseåret är detsamma, eller ett år yngre eller äldre om matchen är öppen för det (`openToAdjacentBirthYears`). |
| **BR-10** | Ingen redigering efter publicering | En publicerad match kan inte ändras. En ändring kräver att hemmalaget avbokar och skapar en ny match. |
| **BR-11** | Slutlägen | `CANCELLED` betyder aktiv avbokning, avslag, återkallelse eller inställning. `EXPIRED` betyder att tiden gick ut utan resultat (ingen motståndare vid starttid, eller ingen bekräftelse av genomförd match inom 48 h). |
| **BR-12** | Tid och tidszon | Lagring och events i UTC. Alla regler och frister räknas i `Europe/Stockholm` (se 1.4). |
| **BR-13** | Lagprofilens värden | Beräknas rullande över de senaste N recensionerna (högst 10). Inget visas förrän N är minst 3. **Bedömd nivå:** mappa `Level` till heltal (`EASY` = 1, `EASY_PLUS` = 2, `MEDIUM` = 3, `MEDIUM_PLUS` = 4, `HARD` = 5, `HARD_PLUS` = 6), sortera stigande och välj element nummer (N+1)/2 vid udda N och element nummer N/2 vid jämnt N (det lägre av de två mittvärdena, räknat från 1). Mappa tillbaka till `Level`. **Fair Play:** genomsnittet av recensionernas totalbetyg, beräknat utan avrundning och visat samt skickat i `REVIEW_AGGREGATED` med en decimal. |
| **BR-14** | Hemmalaget bekräftar genomförd match | `MATCH_COMPLETED` utlöses av att hemmalaget aktivt bekräftar "Match genomförd" efter sluttid, högst 48 h efter sluttid. Annars blir matchen `EXPIRED` och inga recensioner skapas. |
| **BR-15** | Direkt bekräftelse av valt lag | När hemmalaget väljer motståndare blir matchen `MATCH_CONFIRMED` direkt, utan att det valda laget behöver acceptera. Ett lag kan dra tillbaka sin intresseanmälan fram till att det valts. Efter valet gäller återbudsflödet. |
| **BR-16** | Transaktionssäkerhet | Varje statusövergång kontrollerar i samma databastransaktion att objektets nuvarande status är den förväntade. Annars rullas åtgärden tillbaka och användaren får ett felmeddelande. Exempel: hemmalaget väljer ett lag vars intresseanmälan samtidigt dragits tillbaka. |
| **BR-17** | Telefonnummer | Telefonnummer lagras inte på användaren. Ledaren anger det när en match eller intresseanmälan skapas, och det lagras bara i `LeaderContact`. Det är obligatoriskt i båda fallen. |

---

## 6. Funktionella krav & Acceptanskriterier

Format: Givet / När / Då. Krav-ID:n från v1.0 är bibehållna där innebörden är densamma. Nya krav har nya nummer.

### 6.0 Konton, roller och lagprofiler

**FR-U-001: Inloggning**

* **AC-U-001.1:** Givet en användare utan session, när hen väljer "Logga in", då sker autentisering via Google Identity Services och ett konto skapas vid första inloggningen.
* **AC-U-001.2:** Givet en gäst (ej inloggad), när hen öppnar börsen, då visas matcher med status `PUBLISHED` utan kontaktuppgifter. Åtgärder som kräver konto, som att anmäla intresse, kräver inloggning.

**FR-U-002: Lagprofil och ledarkoppling**

* **AC-U-002.1:** Givet en inloggad ledare utan lagkoppling, när hen skapar en lagprofil (klubb, lagnamn, födelseår, kategori), då skapas laget och ledaren kopplas till det.
* **AC-U-002.2:** Givet att laget tillhör IFK Lidingö, när kopplingen skapas, då sätts `approvalStatus = PENDING` och kansliet notifieras. För externa lag sätts `NOT_REQUIRED`.
* **AC-U-002.3:** Givet en andra ledare som kopplar sig till ett redan godkänt IFK Lidingö-lag, då får även den kopplingen `PENDING`. Godkännandet gäller kopplingen, inte bara laget.

**FR-U-003: Godkännande (kansli)**

* **AC-U-003.1:** Givet väntande kopplingar, när kansliet öppnar godkännandevyn, då kan hen godkänna eller avslå varje koppling. Ledaren notifieras om beslutet.
* **AC-U-003.2:** Givet en koppling som är `PENDING` eller `REJECTED`, när ledaren försöker skapa en match, då nekas åtgärden. Ledaren kan fortfarande se börsen.

**FR-U-004: Radering av personuppgifter**

* **AC-U-004.1:** Givet en raderingsbegäran, när den utförs, då tas användarens personuppgifter bort från användarprofilen och kopior på matchkort och reservationer (`homeContact`, `selectedOpponent`, `contact`, `opponent`) anonymiseras. Audit-loggen lämnas orörd eftersom den bara innehåller ett pseudonymt användar-ID.

### 6.1 Process A: Matchgenomförande

**FR-A-101: Matchinitiering & vägval**

* **AC-101.1 (Spår 1, helg):** Givet att en ledare med `APPROVED` koppling vill söka en ny helgtid, när hen väljer en lördag eller söndag minst 21 dagar fram och fyller i spelform, födelseår, kategori, matchnivå och telefonnummer, då skapas matchen med status `RESERVATION_REQUESTED` och `REQUEST_RESERVATION` skickas till Process B.
* **AC-101.2 (Spår 1, vardag):** Givet att ledaren väljer en vardag, när hen försöker skicka begäran, då nekas den med meddelandet "Träningsmatchtider tilldelas endast under helger".
* **AC-101.3 (Spår 2):** Givet att ledaren vill använda en egen träningstid, när hen väljer plan ur masterdata och anger start- och sluttid samt telefonnummer, då publiceras matchen direkt (`PUBLISHED`). Process B startas inte och ingen validering eller överlappsvarning görs.
* **AC-101.4 (Spår 1, för sent):** Givet att önskat datum ligger mindre än 21 dagar fram, när ledaren försöker begära en helgtid, då nekas begäran med meddelandet "Helgtider måste begäras minst 21 dagar i förväg" och ledaren hänvisas till Spår 2.
* **AC-101.5 (Behörighet):** Givet en ledare vars koppling är `PENDING` eller `REJECTED`, när hen försöker skapa en match (Spår 1 eller 2), då nekas åtgärden.

**FR-A-102: Publicering & Matchbörsen**

* **AC-102.1:** Givet en match i `RESERVATION_REQUESTED`, när `RESERVATION_RESERVED` mottas, då uppdateras matchen med plan och tid, status blir `PUBLISHED` och matchen blir synlig på börsen.
* **AC-102.2:** Givet matcher med status `PUBLISHED`, när en användare (även gäst) öppnar börsen, då kan listan filtreras på spelform, datum, födelseår, kategori och matchnivå. Matchkortet visar anläggningens namn och adress. Geografifilter ingår inte i MVP 1.
* **AC-102.3:** Givet en match som inte är `PUBLISHED`, då visas den inte på börsen. Gäster ser aldrig kontaktuppgifter.

**FR-A-103: Intresseanmälan, val & återkallande**

* **AC-103.1 (Intresseanmälan):** Givet en inloggad ledare vars lag matchar enligt BR-09, när hen anmäler intresse för en `PUBLISHED` match och anger telefonnummer, då skapas en intresseanmälan med status `ACTIVE`, `inquiriesCount` ökar och matchen förblir `PUBLISHED`. Ett lag vars tidigare anmälan blev `REJECTED` kan skapa en ny anmälan. Lag som inte matchar kan inte anmäla intresse.
* **AC-103.2 (Val av motståndare):** Givet minst en `ACTIVE` intresseanmälan, när hemmalaget godkänner ett lag, då blir matchen `MATCH_CONFIRMED` direkt (BR-15). Vald anmälan blir `SELECTED`. Övriga `ACTIVE` anmälningar blir `REJECTED` och lagen får e-post. `isUrgent` sätts till `false`. Telefon och e-post blir synliga för båda parter. I Spår 1 skickas `RESERVATION_ACCEPTED`.
* **AC-103.3 (Dra tillbaka intresse):** Givet en `ACTIVE` intresseanmälan på en `PUBLISHED` match, när ledaren drar tillbaka den innan laget valts, då blir den `WITHDRAWN` och `inquiriesCount` minskar.
* **AC-103.4 (Samtidigt val och återkallande):** Givet att hemmalaget väljer ett lag medan laget samtidigt drar tillbaka sin anmälan, när transaktionen kontrollerar att anmälan fortfarande är `ACTIVE`, då rullas valet tillbaka om anmälan hunnit bli `WITHDRAWN`, och hemmalaget får meddelandet "Intresseanmälan har dragits tillbaka av motståndaren" (BR-16).

**FR-A-104: Återbud från bortalag**

* **AC-104.1:** Givet en match i `MATCH_CONFIRMED`, när det valda laget registrerar återbud före starttid, då notifieras hemmalagets ledare via e-post (akut notis enligt NFR-03).
* **AC-104.2:** Givet ett återbud, när hemmalaget väljer "Sök ny motståndare", då återgår matchen till `PUBLISHED` med `isUrgent = true` (röd flagga). `awayTeamId` och `selectedOpponent` rensas, den tidigare valda anmälan blir `WITHDRAWN` och matchen tar emot nya intresseanmälningar. Tidigare avvisade anmälningar återaktiveras inte, men dessa lag kan skapa en ny intresseanmälan. Inget event skickas till Process B (BR-04).
* **AC-104.3:** Givet ett återbud, när hemmalaget väljer "Avboka match", då gäller AC-105.1.
* **AC-104.4:** Givet Spår 1 efter återbud, när hemmalaget godkänner en ny motståndare, då skickas `RESERVATION_ACCEPTED` igen och Process B skriver över motståndarinfon utan statusändring (AC-205.2).

**FR-A-105: Avbokning**

* **AC-105.1:** Givet en match i `RESERVATION_REQUESTED`, `PUBLISHED` eller `MATCH_CONFIRMED` med starttid ej passerad, när hemmalaget avbokar, då blir matchen `CANCELLED`. I Spår 1 skickas `RESERVATION_WITHDRAWN`. Valt lag respektive `ACTIVE` intresseanmälningar notifieras.
* **AC-105.2 (Kappslöpning):** Givet en avbokad match, när ett sent `RESERVATION_RESERVED` mottas, då ignoreras det av Process A och loggas. Process B frigör planen (AC-203.2).
* **AC-105.3 (Ingen redigering):** Givet en match i `PUBLISHED` eller senare, då finns ingen funktion för att ändra tid, plan, spelform eller övriga fält. En ändring kräver avbokning och en ny match (BR-10).

**FR-A-106: Utgång utan motståndare**

* **AC-106.1:** Givet en match i `PUBLISHED`, när starttiden passerat utan vald motståndare, då blir matchen `EXPIRED` och försvinner från börsen. Om det är Spår 1 med en `ACCEPTED` reservation skickas `MATCH_EXPIRED`.

**FR-A-107: Bekräfta genomförd match**

* **AC-107.1:** Givet en match i `MATCH_CONFIRMED` med sluttid passerad, när hemmalaget bekräftar "Match genomförd" inom 48 timmar, då blir matchen `COMPLETED` och `MATCH_COMPLETED` skickas till Process B (Spår 1) och Process C.
* **AC-107.2:** Givet en match i `MATCH_CONFIRMED`, när 48 timmar efter sluttid (`Europe/Stockholm`) passerat utan bekräftelse, då blir matchen `EXPIRED`. Inga recensioner skapas och i Spår 1 skickas `MATCH_EXPIRED`.
* **AC-107.3 (Påminnelser):** Givet en match i `MATCH_CONFIRMED` som inte bekräftats som genomförd, då skickas en e-postpåminnelse till hemmalagets ledare vid sluttid och en andra påminnelse 24 timmar efter sluttid. **[FÖRSLAG]** Tidpunkterna är mitt förslag och inte beslutade.

### 6.2 Process B: Planbokning

**FR-B-201: Översikt & tilldelning**

* **AC-201.1:** Givet ett inloggat kansli, när hen öppnar kön, då visas ärenden i `REQUESTED` sorterade på datum med spelform, födelseår och kategori.
* **AC-201.2:** Givet ett ärende i `REQUESTED`, när kansliet väljer anläggning och plan ur masterdata, då erbjuds bara planer som stödjer den begärda spelformen. Överlappande bokning på samma plan och tid ger en varning som kansliet kan åsidosätta. Vid bekräftelse blir reservationen `RESERVED` och `RESERVATION_RESERVED` skickas.
* **AC-201.3:** Givet ett ärende som är `WITHDRAWN_BY_HOME`, då kan kansliet inte tilldela plan och ärendet visas som avbokat.

**FR-B-202: Automatisk 14-dagarsbevakning**

* **AC-202.1 (Påminnelse):** Givet en reservation i `RESERVED` utan accept, när det är 18 dagar kvar till matchdatum, då skickas en e-postpåminnelse till hemmalagets ledare. Blir reservationen `RESERVED` först efter den tidpunkten skickas ingen påminnelse.
* **AC-202.2 (Automatisk återkallelse):** Givet en reservation i `RESERVED` utan accept, när matchdatum minus 14 dagar kl 23:59:59 `Europe/Stockholm` har passerat, då återkallar systemet reservationen automatiskt (`REVOKED_BY_DEADLINE`), frigör plantiden och skickar `RESERVATION_REVOKED`. Ingen manuell åtgärd krävs. Matchen blir `CANCELLED` i Process A.

**FR-B-203: Livscykelavslut**

* **AC-203.1:** Givet en reservation i `ACCEPTED`, när `MATCH_COMPLETED` mottas, då blir den `COMPLETED` och arkiveras.
* **AC-203.2:** Givet en reservation i `REQUESTED`, `RESERVED` eller `ACCEPTED`, när `RESERVATION_WITHDRAWN` mottas, då blir den `WITHDRAWN_BY_HOME` och plantiden frigörs omedelbart.
* **AC-203.3:** Givet en reservation i `ACCEPTED`, när `MATCH_EXPIRED` mottas, då blir den `CLOSED_EXPIRED`, plantiden frigörs och reservationen arkiveras.

**FR-B-204: Avslag**

* **AC-204.1:** Givet ett ärende i `REQUESTED`, när kansliet avslår med en obligatorisk orsak (högst 200 tecken), då blir reservationen `REJECTED_BY_OFFICE` och `RESERVATION_REJECTED` skickas. Process A sätter matchen till `CANCELLED` och visar orsaken för hemmalaget.

**FR-B-205: Hantering av vald motståndare**

* **AC-205.1:** Givet en reservation i `RESERVED`, när `RESERVATION_ACCEPTED` mottas, då blir den `ACCEPTED`, motståndarinfon sparas och bokningen låses.
* **AC-205.2:** Givet en reservation i `ACCEPTED`, när `RESERVATION_ACCEPTED` mottas (ny motståndare efter återbud), då förblir den `ACCEPTED` och motståndarinfon skrivs över.

**FR-B-206: Inställning av reserverad eller accepterad bokning**

* **AC-206.1:** Givet en reservation i `RESERVED` eller `ACCEPTED`, när kansliet ställer in den med en obligatorisk orsak (högst 200 tecken), då blir den `CANCELLED_BY_OFFICE`, plantiden frigörs och `RESERVATION_CANCELLED_BY_OFFICE` skickas. Matchen blir `CANCELLED` och hemmalaget, valt lag (om valt) och `ACTIVE` sökande notifieras (akut).

**FR-B-207: Masterdata för anläggningar och planer**

* **AC-207.1:** Givet ett inloggat kansli, när hen hanterar masterdata, då kan hen skapa, ändra och inaktivera anläggningar och planer (namn, adress, underlag, vilka spelformer planen klarar). Inaktiva planer erbjuds inte vid tilldelning.

### 6.3 Process C: Fair Play-recension

**FR-C-301: Instansiering & inlämning**

* **AC-301.1:** Givet att `MATCH_COMPLETED` mottas, då skapas två recensionsinstanser med status `PENDING` och båda ledarna notifieras via e-post.
* **AC-301.2:** Givet en instans, när ledaren fyller i formuläret, då lämnas den in oberoende av motpartens instans.
* **AC-301.3 (Formulär):** Formuläret har delbetyg 1–3 för spelare, ledare och publik samt en bedömning av det recenserade lagets nivå på skalan `Level`. Delbetyg för spelare och ledare samt nivå är obligatoriska. Publik kan sättas till "ej tillämpligt" och räknas då inte med. Totalbetyget är genomsnittet av delbetygen. Det finns ingen fritext och ingen incidentflagga.

**FR-C-302: Blind review, frist & synlighet**

* **AC-302.1:** Givet en recension i `SUBMITTED`, då är den dold för det recenserade laget. När båda recensionerna är `SUBMITTED` blir båda `PUBLISHED` och räknas in i lagprofilerna samtidigt.
* **AC-302.2:** Givet att 7 dagar passerat sedan `MATCH_COMPLETED` och exakt en recension är `SUBMITTED`, då blir den `PUBLISHED` och räknas in. Den andra blir `EXPIRED`.
* **AC-302.3:** Givet att 7 dagar passerat och ingen recension är `SUBMITTED`, då blir båda `EXPIRED` och inget räknas in.
* **AC-302.4 (Synlighet):** Det recenserade laget ser aldrig enskilda recensioner, bara aggregerade värden på lagprofilen. Enskilda recensioner kan läsas av administratören.

**FR-C-303: Lagprofil**

* **AC-303.1:** Givet att en recension blir `PUBLISHED`, då räknas lagprofilen om över de senaste recensionerna (högst 10) enligt BR-13: bedömd nivå är medianen och Fair Play är genomsnittet av totalbetygen. `REVIEW_AGGREGATED` skickas.
* **AC-303.2:** Givet färre än 3 recensioner i fönstret, då visas inga värden på lagprofilen (`visible = false`).

**Utgår ur MVP 1:** AC-302.3 i v1.0 (incidentflagga och notis till sportchef) och rollen "sportchef".

---

## 7. Icke-funktionella krav (NFR)

| ID | Område | Krav |
| :---- | :---- | :---- |
| **NFR-01** | Mobile First | Webbgränssnittet är responsivt och fungerar i webbläsare på iOS och Android. Ingen native app och ingen push-notifiering i MVP 1. **[FÖRSLAG testkriterium]** Alla vyer i Process A och C fungerar i 360 px bredd utan horisontell scroll. |
| **NFR-02** | GDPR & integritet | Inga personuppgifter om minderåriga lagras. Endast myndiga ledare och kanslipersonal registreras. Fair Play-recensioner har inga fritextfält. Vid radering tas personuppgifter bort från användarprofilen och kopior på matchkort och reservationer anonymiseras (AC-U-004.1). Lagringstider är inte specificerade (se avsnitt 10). |
| **NFR-03** | Notifieringar | Endast e-post. Akut notis inom 30 sekunder och händelsenotiser inom 60 sekunder, mätt från eventets `occurredAt` till att e-postleverantören accepterat meddelandet (inte att ledaren hunnit läsa). Akut är återbud från valt lag (AC-104.1). **[FÖRSLAG]** Kansliets inställning av en reserverad eller accepterad bokning (AC-206.1) klassas också som akut. |
| **NFR-04** | Prestanda (driftmål) | p95 under 500 ms för sökning och filtrering på börsen, mätt i produktion med övervakning. Larm sätts vid överskridande. Inget lasttest krävs före lansering. |
| **NFR-05** | Revisionslogg | Append-only. Varje statusövergång loggas med `eventId`, pseudonymt användar-ID och tidsstämpel i UTC. Loggen innehåller inga namn, e-postadresser eller telefonnummer. **[FÖRSLAG testkriterium]** Varje övergång i avsnitt 3 ger exakt en loggrad. |
| **NFR-06** | Eventhantering | Intern outbox, idempotent mottagare på `eventId` och ordning per `matchId` (se 4.0). |
| **NFR-07** | Tid och tidszon | Lagring och events i UTC. Alla regler och frister räknas i `Europe/Stockholm` (se 1.4 och BR-12). |
| **NFR-08** | Autentisering | Google Identity Services för alla konton (se 1.6). |

---

## 8. Utanför omfattning (Out of Scope) i MVP 1

1. **Realtidschatt:** Kommunikation sker utanför systemet via de kontaktuppgifter som delas.
2. **Ekonomimodul:** Faktureringsstöd för planhyra och domararvoden.
3. **Turneringsstöd:** Poängtabeller och seriespel.
4. **SMS och push-notifiering:** Endast e-post.
5. **Incidentflaggning och incidenthantering:** Ingen `incidentFlag` och ingen roll "sportchef".
6. **Redigering av match efter publicering:** Ändring kräver avbokning och ny match.
7. **Geografifilter:** Läggs till när fler klubbar ansluter.
8. **Flera klubbar (multi-tenant):** Endast IFK Lidingö i MVP 1.
9. **Fritext i Fair Play-recensioner:** Ingen kommentar.
10. **Missbruksskydd för externa lag:** Ingen begränsning av antal lagprofiler eller samtidiga intresseanmälningar per användare.

---

## 9. Notifieringsmatris **[FÖRSLAG, ej beslutat]**

Alla notifieringar skickas som e-post (NFR-03). Matrisen är ett utkast att granska.

| # | Händelse | Mottagare | Typ |
| :---- | :---- | :---- | :---- |
| 1 | IFK Lidingö-koppling väntar på godkännande | Kansli | Händelse |
| 2 | Koppling godkänd eller avslagen | Berörd ledare | Händelse |
| 3 | Ny reservationsförfrågan (Spår 1) | Kansli | Händelse |
| 4 | Plan tilldelad (`RESERVATION_RESERVED`) | Hemmalagets ledare | Händelse |
| 5 | Förfrågan avslagen (`RESERVATION_REJECTED`), med orsak | Hemmalagets ledare | Händelse |
| 6 | Ny intresseanmälan | Hemmalagets ledare | Händelse |
| 7 | Motståndare vald (med kontaktuppgifter) | Valt lag och hemmalaget | Händelse |
| 8 | Intresseanmälan avvisad (annat lag valt) | Övriga sökande lag | Händelse |
| 9 | Återbud från valt lag | Hemmalagets ledare | Akut |
| 10 | Hemmalaget avbokar | Valt lag eller `ACTIVE` sökande | Händelse |
| 11 | Påminnelse 18 dagar före matchdag (`RESERVED` utan accept) | Hemmalagets ledare | Händelse |
| 12 | Reservation återkallad efter 14-dagarsfristen | Hemmalaget och `ACTIVE` sökande | Händelse |
| 13 | Kansliet ställer in reserverad eller accepterad bokning, med orsak | Hemmalaget, valt lag (om valt) och `ACTIVE` sökande | Akut |
| 14 | Match utgången utan motståndare (`EXPIRED`) | Hemmalaget och `ACTIVE` sökande | Händelse |
| 15 | Påminnelse: bekräfta "Match genomförd" (vid sluttid) | Hemmalagets ledare | Händelse |
| 16 | Påminnelse: bekräfta "Match genomförd" (24 h efter sluttid) | Hemmalagets ledare | Händelse |
| 17 | Match ej bekräftad som genomförd inom 48 h (`EXPIRED`) | Hemmalagets ledare | Händelse |
| 18 | Fair Play-recension att fylla i | Båda ledarna | Händelse |

---

## 10. Öppna punkter och förslag

Punkterna nedan är inte beslutade. Där ett förslag anges har det använts som utkast i specen och är markerat **[FÖRSLAG]**.

| # | Punkt | Status / förslag |
| :---- | :---- | :---- |
| 1 | Inloggning för användare utan Google-konto | Inte beslutat. Förslag: inloggning med engångslänk via e-post, eller att användaren skapar ett Google-konto med sin befintliga e-postadress. Lokalt konto med lösenord avråds. |
| 2 | Test av roller utan många Google-konton | Inte beslutat. Förslag: en inloggningsväxlare med seedade testanvändare per roll som bara finns i dev och test (avstängd i produktion), samt sessioner skapade direkt i automatiska tester. |
| 3 | Notifieringsmatris och påminnelsetidpunkter | Utkast i avsnitt 9. Tidpunkterna för påminnelserna om "Match genomförd" (vid sluttid och 24 h efter) är mitt förslag. |
| 4 | Kategorimatchning för `MIXED` | Tolkning i BR-09: samma kategori krävs, så `MIXED` matchar bara `MIXED`. |
| 5 | Åldersflexibilitet | Tolkning: en flagga (`openToAdjacentBirthYears`) som gäller både ett år yngre och ett år äldre. |
| 6 | Lagringstider | Inte specificerade för matcher, recensioner, användarkonton och kontaktkopior på matchkort. Kontaktkopior rensas bara vid raderingsbegäran. |
| 7 | Behörighet för raderingsbegäranden | Förslag: administratören hanterar dem (avsnitt 1.5). |
| 8 | Rollmatrisens detaljer | Rollerna är beslutade. Detaljerna i 1.5 är härledda och bör granskas. |
| 9 | Förifyllning av telefonnummer | Telefonnumret anges vid varje match och intresseanmälan och lagras bara i `LeaderContact` (BR-17). Om ledaren ska slippa skriva in det igen är inte beslutat. |
| 10 | Bortalaget initierar bekräftelsen av genomförd match | Övervägdes efter kravanalytikerns förslag. Inte med i MVP 1, eftersom det kräver hantering av oenighet mellan lagen. Hemmalaget bekräftar och får påminnelser (AC-107.3). |

---

## Bilaga A: Beslutslogg och spårbarhet

| # | Beslut | Genomfört i |
| :---- | :---- | :---- |
| 1 | `RESERVATION_REVOKED` ger `CANCELLED` i Process A | A10, 4.6, BR-03 |
| 2 | Kansliet kan avslå en förfrågan med orsak (`RESERVATION_REJECTED`), matchen blir `CANCELLED` | A4, B3, 4.3, FR-B-204 |
| 3 | Kansliet kan ställa in en `ACCEPTED`-bokning med orsak (`RESERVATION_CANCELLED_BY_OFFICE`), matchen blir `CANCELLED` | A11, B10, 4.7, FR-B-206 |
| 4 | 14-dagarsregeln är helt automatisk | B7, BR-03, AC-202.2 |
| 5 | Spår 1 nekas om matchdatum är mindre än 14 dagar bort (ändrat till 21 dagar i beslut 31) | BR-06, AC-101.4 |
| 6 | Vid återbud tillåter Process B `RESERVATION_ACCEPTED` även från `ACCEPTED` | B8, BR-04, AC-205.2, AC-104.4 |
| 7 | `PUBLISHED` utan motståndare vid starttid blir `EXPIRED` | A12, BR-11, AC-106.1 |
| 8 | Hemmalaget bekräftar "Match genomförd", annars `EXPIRED` efter 48 h | A13, A14, BR-14, AC-107.1, AC-107.2, 4.8 |
| 9 | Avbokning från `RESERVATION_REQUESTED`, sena `RESERVATION_RESERVED` ignoreras | A5, B4, AC-105.1, AC-105.2, 3.2 |
| 10 | UTC för lagring och events, regler i `Europe/Stockholm` | 1.4, BR-12, NFR-07, avsnitt 4 |
| 11 | MVP för en klubb (IFK Lidingö) | 1.3, BR-07 |
| 12 | Konto för alla ledare och kansli, Google Identity Services, gäster kan se börsen | 1.5, 1.6, FR-U-001, FR-U-002 |
| 13 | Lagprofiler skapas av ledare, godkännande av IFK Lidingö-kopplingar | FR-U-002, FR-U-003, BR-08, `TeamMembership` |
| 14 | Valt lag bekräftas direkt, intresse kan dras tillbaka före val | BR-15, AC-103.2, AC-103.3, `InquiryEntity` |
| 15 | Masterdata för anläggningar och planer, överlapp ger varning | FR-B-207, AC-201.2, `Facility`, `Pitch` |
| 16 | Födelseår och kategori ersätter åldersgrupp, ett år yngre eller äldre om öppet | BR-09, AC-103.1, `TeamCategory`, `MatchEntity` |
| 17 | Tre begrepp: matchnivå, lagets bedömda nivå, Fair Play, med sexgradig skala | `Level`, `matchLevel`, `assessedLevel`, AC-301.3 |
| 18 | Fair Play som tre delbetyg 1–3, totalbetyg är genomsnittet | AC-301.3, `FairPlayReviewEntity` |
| 19 | Lagprofil rullande över 10 recensioner, median och genomsnitt, minst 3 | BR-13, FR-C-303 |
| 20 | Ingen kommentar, det recenserade laget ser bara aggregat, administratören läser enskilda recensioner | AC-302.4, `FairPlayReviewEntity` |
| 21 | Blind review-väntan behålls | BR-05, AC-302.1, C3, C4 |
| 22 | Bara e-post för notifieringar | NFR-03, avsnitt 9 |
| 23 | Pseudonymt användar-ID i audit-loggen, personuppgifter raderas från profilen | NFR-05, `AuditLogEntry`, AC-U-004.1 |
| 24 | Spår 2: tränarna litar på varandra, ingen validering eller överlappsvarning | BR-02, AC-101.3 |
| 25 | Geografi tas bort ur MVP | AC-102.2, avsnitt 8 |
| 26 | Intern outbox, idempotens på `eventId`, ordning per `matchId` | 4.0, NFR-06 |
| 27 | Inget lasttest, prestanda som driftmål | NFR-04 |
| 28 | `incidentFlag` skippas helt i MVP 1 | Avsnitt 8, AC-301.3 |
| 29 | Fair Play-fristen på 7 dagar räknas från `MATCH_COMPLETED`, ingen inlämning ger `EXPIRED` | C1, C4, C5, AC-302.2, AC-302.3 |
| 30 | Ingen redigering efter publicering | BR-10, AC-105.3 |
| 31 | Minsta ledtid för Spår 1 är 21 dagar (ändrar beslut 5) | BR-06, A1, AC-101.1, AC-101.4 |
| 32 | Påminnelser till hemmalaget för att bekräfta genomförd match | AC-107.3, avsnitt 9 |
| 33 | Telefonnummer lagras bara i `LeaderContact`, inte i `User` | `User`, `LeaderContact`, BR-17, AC-101.1, AC-101.3, AC-103.1 |
| 34 | Missbruksskydd för externa lag skippas i MVP 1 | Avsnitt 8 |

---

## Bilaga B: Förtydliganden efter granskning av kravanalytiker

| Analytikerns punkt | Hantering |
| :---- | :---- |
| 1.1 Tidsfälla för Spår 1 | Beslut 31: minsta ledtid 21 dagar (BR-06). Analytikerns förslag på 18 dagar valdes bort, eftersom 18-dagarspåminnelsen då aldrig skulle skickas. |
| 1.2 Inställning i `RESERVED` | Genomfört: B10, AC-206.1, `RESERVATION_CANCELLED_BY_OFFICE`. |
| 1.3 Glömd bekräftelse av genomförd match | Beslut 32: påminnelser till hemmalaget (AC-107.3). Att bortalaget kan initiera bekräftelsen är inte med i MVP 1 (öppen punkt 10). |
| 1.4 Avvisade lag efter återbud | Genomfört: AC-103.1 och AC-104.2. Inget återaktiveras automatiskt, men lagen kan skapa en ny anmälan. |
| 2.1 Telefonnummer | Beslut 33: telefonnummer bara i `LeaderContact`. Ingen verifiering, eftersom den skulle kräva SMS (beslut 22). |
| 2.2 `reservationId` i `MATCH_COMPLETED` | Genomfört: valfritt fält och routing till bara Process C (4.0, 4.8). |
| 2.3 Median | Genomfört: formaliserad i BR-13 och AC-303.1. |
| 3.1 Samtidigt val och återkallande | Genomfört: BR-16 och AC-103.4. |
| 3.2 `MATCH_EXPIRED` i Process B | Genomfört: beslutad. Statusen heter `CLOSED_EXPIRED` (B12, 4.9, AC-203.3). |
| 4.1 Missbruksskydd för externa lag | Beslut 34: skippas i MVP 1 (avsnitt 8). |
| Rekommendation: bara Google-inloggning | Inte ändrat. Beslut 12 gäller, men frågan om användare utan Google-konto och test av roller är fortsatt öppen (öppna punkter 1 och 2). |
