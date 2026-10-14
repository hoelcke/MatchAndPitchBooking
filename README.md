# Matchbörsen & Planbokning – IFK Lidingö

Webbapplikation för träningsmatcher enligt [kravspecifikationen v1.1.1](docs/kravspecifikation-v1.1.1.md).

Utkastet täcker båda spåren:

- **Spår 1 (ny helgtid):** hemmalaget begär en lördag eller söndag minst 21 dagar fram. Förfrågan hamnar i
  kansliets kö (Process B), kansliet tilldelar plan eller avslår, och matchen publiceras när planen är
  tilldelad. 14-dagarsregeln återkallar tiden automatiskt om ingen motståndare valts, och kansliet kan
  ställa in en bokning.
- **Spår 2 (egen träningstid):** hemmalaget väljer plan ur masterdata och publicerar matchen direkt.
  Kansliet behöver inte tillfrågas.

Hela kedjan efter publiceringen ingår: intresseanmälan, val av motståndare, återbud, avbokning, utgång,
"Match genomförd" och Fair Play-recensioner med lagprofiler.

## Kom igång

Kräver Node.js 22.13 eller senare (använder inbyggda `node:sqlite`, inga native-beroenden).

```bash
npm install
npm run dev        # API på :3000 och webben på http://localhost:5173
```

Databasen (`data/matchborsen.db`) skapas och fylls med testdata vid första start i dev.
`npm run seed` återskapar den. Logga in via **Logga in → Testanvändare**:

| Användare | Roll | Visar |
| :-- | :-- | :-- |
| Lena Lidingö | Ledare, IFK Lidingö P2015 (godkänd) | Skapa match, välja motståndare, bekräfta genomförd |
| Fia Flicktränare | Ledare, IFK Lidingö F2014 (godkänd) | Egen match på börsen |
| Per Pending | Ledare, väntar på kansliet | AC-101.5: får inte skapa match |
| Anna Lind | Hammarby IF P2015 (externt) | Intresseanmälan, återbud, Fair Play |
| Erik Djurman | Djurgårdens IF P2016 (externt) | BR-09 med ±1 år |
| Sara Täby | Täby FK F2014 (externt) | Flicklag |
| Nora Ny | Ny ledare utan lag | Skapa lagprofil |
| Karin Kansli | Kansli | Kö för helgtider (Spår 1), godkänna ledarkopplingar, masterdata |
| Adam Admin | Administratör | Läsa enskilda recensioner |

**Dev-sidan** (`/dev`) har en tidsmaskin som flyttar serverns klocka framåt och kör schemaläggaren, så att
starttid, 14-dagarsregeln, 48-timmarsfristen och 7-dagarsfristen kan provas direkt. Där finns också utkorgen (all e-post
loggas i stället för att skickas), outbox-event och revisionsloggen.

Övriga kommandon:

```bash
npm test           # domäntester (vitest)
npm run typecheck
npm run build && npm start   # produktionsläge, SPA:n serveras av API-servern
```

Konfiguration via miljövariabler, se [`.env.example`](.env.example). Med `GOOGLE_CLIENT_ID` satt visas
Google-knappen (Google Identity Services) och ID-token verifieras på servern. `OFFICE_EMAILS` och
`ADMIN_EMAILS` styr vilka konton som får rollen kansli respektive administratör vid första inloggningen.
Dev-verktygen är avstängda när `NODE_ENV=production` om inte `ENABLE_DEV_TOOLS=true`.

## Arkitektur

Dokumentation i `docs/`: kravspecifikationen, ER-diagram över databasen (`erd.md`, Mermaid) och
arbetsflödena som case lifecycles (`arbetsfloden.html`) och informationsobjekten med fält, relationer och
integrationer (`informationsobjekt.html`) samt rollerna med behörighetsmatris (`personas.html`).
HTML-filerna öppnas i en webbläsare. `bpmn/matchborsen.bpmn` är processerna som BPMN 2.0 för Camunda 8 Modeler
(tre pooler med meddelandeflöden för händelserna), med en färdig bild i `bpmn/matchborsen.svg`.

```
src/
  shared/            Delas av server och klient
    types.ts         Domäntyper från specens avsnitt 2
    rules.ts         Rena affärsregler: BR-09, BR-13 (median), totalbetyg
    time.ts          UTC <-> Europe/Stockholm, lokala dagar över sommartid
    labels.ts        Svenska etiketter
  server/
    infra/           db (SQLite, transaktioner), outbox, audit, email, clock
    modules/
      identity.ts    Konton, sessioner, lag, ledarkopplingar (FR-U)
      masterdata.ts  Anläggningar och planer (FR-B-207)
      matches.ts     Process A, tillståndsmaskinen i 3.1
      reservations.ts  Process B, tillståndsmaskinen i 3.2 (Spår 1)
      fairplay.ts    Process C och lagprofil (3.3, BR-13)
    runtime.ts       Outbox-dispatcher, e-postleverans, schemaläggare
    app.ts           REST-API (Express)
  web/               React-SPA, mobile first
```

Processerna är separata moduler. De kommunicerar via en **intern outbox** (avsnitt 4.0):

- Varje tillståndsändring och dess event skrivs i **samma databastransaktion**.
- `sequence` är strikt stigande per `matchId`. Dispatchern levererar i sekvensordning per match och
  mottagare. Om ett event misslyckas väntar senare event för samma match.
- Idempotens: `processed_events (consumer, event_id)` gör att varje mottagare behandlar ett event högst en gång.
- Routing enligt tabellen i 4.0. `MATCH_COMPLETED` utan `reservationId` (Spår 2) går bara till Process C.
- Outbox-tabellen kan senare tömmas mot en extern broker utan att processerna ändras.

**BR-16 (transaktionssäkerhet):** alla statusövergångar är `UPDATE … WHERE id = ? AND status = <förväntad>`.
Om ingen rad påverkas kastas ett konfliktfel och allt rullas tillbaka (t.ex. AC-103.4: "Intresseanmälan har
dragits tillbaka av motståndaren").

**NFR-05 (revisionslogg):** varje övergång ger en rad med `eventId`, pseudonymt användar-ID och UTC-tid.
Tabellen är append-only via databastriggers.

**E-post (NFR-03):** köas i `email_outbox` i samma transaktion som händelsen och skickas av en
bakgrundsprocess var 5:e sekund, akuta först. `ConsoleEmailSender` byts mot en riktig leverantör i drift.

**Tid (1.4):** allt lagras i UTC. Lokala datum och tider tolkas i `Europe/Stockholm`, även över sommartidsskiftet.

## Spårbarhet: vad som är implementerat

| Krav | Status |
| :-- | :-- |
| A1, AC-101.1/101.2/101.4/101.5, BR-01, BR-06 | Skapa match i Spår 1 (helgtid via kansliet) |
| A2, AC-101.3, AC-101.5, BR-02, BR-07, BR-08, BR-17 | Skapa match i Spår 2 |
| B1–B12, FR-B-201–206, A3–A5, A10, A11 | Kansliets kö: tilldela plan (överlappsvarning), avslå, ställa in, livscykel |
| BR-03, BR-04, FR-B-202 | 14-dagarsregeln med påminnelse 18 dagar före, fristen räknas inte om efter återbud |
| FR-A-102, AC-102.2/102.3 | Börsen med filter, gäster ser inga kontaktuppgifter |
| A6, FR-A-103, BR-09, BR-15, BR-16 | Intresseanmälan, val, tillbakadragande, kappslöpning |
| A7, FR-A-104, BR-04 | Återbud (akut e-post, röd flagga) |
| A8, A9, FR-A-105, BR-10 | Avbokning, ingen redigering |
| A12, FR-A-106 | Utgång utan motståndare vid starttid (`MATCH_EXPIRED` till B i Spår 1) |
| A13, A14, FR-A-107, BR-14 | "Match genomförd" inom 48 h, påminnelser vid sluttid och +24 h |
| C1–C5, FR-C-301–303, BR-05, BR-13 | Blind Fair Play-recension, lagprofil (median, snitt, min 3) |
| FR-U-001–003 | Google-inloggning, lagprofiler, kansliets godkännande |
| FR-B-207 | Masterdata för anläggningar och planer |
| 4.0, NFR-05/06/07 | Outbox, idempotens, ordning, revisionslogg, tidszon |
| Avsnitt 9 | Notifieringar #1–18 |

**Inte med i utkastet:** radering av personuppgifter (FR-U-004) och en riktig e-postleverantör.

## Tolkningar som bör granskas

1. **Återbud (A7 mot AC-104.2):** tabellen A7 säger att matchen går direkt till `PUBLISHED`, medan AC-104.2
   beskriver att hemmalaget väljer "Sök ny motståndare". Utkastet följer A7: matchen återgår direkt till
   börsen med röd flagga, och hemmalaget kan avboka om de inte vill söka ny motståndare.
2. **48 timmar** räknas som 48 faktiska timmar efter sluttid. **7 dagar** räknas som kalenderdagar i
   `Europe/Stockholm` (4.8). Bekräftelse exakt vid 48 h är tillåten.
3. **Starttid i Spår 2** måste ligga i framtiden. Annars skulle matchen utgå direkt (A12).
4. **Plan och spelform i Spår 2:** BR-02 säger "ingen validering", så en plan som inte är registrerad för
   spelformen ger bara en varning, inte ett stopp.
5. **Kontaktuppgifter:** hemmalaget ser de sökande lagens namn och lagprofil, men telefon och e-post
   visas först efter valet (AC-103.2). Valt lag ser då hemmalagets kontakt.
6. **Intresseanmälningar** på en match som avbokas eller utgår behåller status `ACTIVE`. Specen anger ingen övergång.
7. **Externa lag:** en andra ledare kan koppla sig till ett externt lag utan godkännande (`NOT_REQUIRED`),
   i linje med avsnitt 8 punkt 10.
8. **Påminnelsetidpunkterna** (vid sluttid och +24 h) är fortfarande **[FÖRSLAG]** i specen.
9. **Spår 1 före tilldelning:** matchen håller den önskade tiden som start- och sluttid och har tomma
   planfält tills `RESERVATION_RESERVED` tas emot (A3). Den visas inte på börsen.
10. **`reservationId`:** `REQUEST_RESERVATION` (4.1) saknar id, så Process B skapar reservationen och Process A
    får id:t med `RESERVATION_RESERVED` eller `RESERVATION_REJECTED`. Ett `RESERVATION_WITHDRAWN` från
    `RESERVATION_REQUESTED` (A5) saknar därför `reservationId`. Process B hittar reservationen via `matchId`.
11. **Tid anges som starttid och längd** (`durationMinutes`, 60 min som standard i formulären), både när en
    match skapas och när kansliet tilldelar plan. Sluttiden är starttid plus längd och måste ligga samma dag.
    `preferredTimeWindow` (4.1) blir den önskade tiden, t.ex. `10:00-11:00`. Kansliet kan ändra starttid och
    längd vid tilldelningen. Att den tilldelade tiden ligger inom den önskade kontrolleras inte.
12. **Överlapp (B2)** kontrolleras mot andra Spår 1-bokningar som håller en plantid (`RESERVED`, `ACCEPTED`),
    inte mot Spår 2-matcher, eftersom Spår 2 inte ska påverka kansliet (BR-02).
13. **14-dagarsfristen (BR-03)** spärrar även val av motståndare i Process A när reservationen fortfarande är
    `RESERVED` och fristen passerat, så att ett val strax efter fristen inte hinner före den automatiska
    återkallelsen. Schemaläggaren levererar väntande event före fristkontrollen.
14. **Påminnelsen 18 dagar före (AC-202.1)** skickas vid lokal midnatt 18 dagar före matchdatum.
15. **Obehandlad förfrågan:** specen anger ingen regel för en förfrågan som kansliet aldrig hanterar. Matchen
    stannar i `RESERVATION_REQUESTED` tills hemmalaget avbokar eller kansliet beslutar.
16. **Ignorerade event** (avsnitt 3, AC-105.2) loggas i revisionsloggen som `IGNORED <eventtyp> (status …)`.
17. **Kansliets inställning (A11)** skickas som akut e-post enligt **[FÖRSLAG]** i NFR-03.

## Tekniska val

- **SQLite via `node:sqlite`** ger en körbar MVP utan installationer. Modulen är markerad som experimentell
  i Node 22. All SQL är standard och transaktionerna är korta, så ett byte till PostgreSQL påverkar bara
  `infra/db.ts` och några `INSERT OR IGNORE`.
- **Express 5 + React 19 (Vite)**, TypeScript i hela kedjan. Klienten importerar bara typer från servern.
- **Sessioner** i databasen med httpOnly-cookie (`SameSite=Lax`). Ändrande anrop måste ha `Content-Type: application/json`,
  vilket stoppar enkel CSRF via formulär.
