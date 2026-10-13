# Matchbörsen & Planbokning – IFK Lidingö

Webbapplikation för träningsmatcher enligt [kravspecifikationen v1.1.1](docs/kravspecifikation-v1.1.1.md).

**Första utkastet täcker Spår 2:** hemmalaget har redan en egen träningstid, väljer plan ur masterdata
och publicerar matchen direkt på Matchbörsen. Kansliet behöver inte tillfrågas. Hela kedjan efter
publiceringen ingår: intresseanmälan, val av motståndare, återbud, avbokning, utgång, "Match genomförd"
och Fair Play-recensioner med lagprofiler.

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
| Karin Kansli | Kansli | Godkänna ledarkopplingar, masterdata |
| Adam Admin | Administratör | Läsa enskilda recensioner |

**Dev-sidan** (`/dev`) har en tidsmaskin som flyttar serverns klocka framåt och kör schemaläggaren, så att
starttid, 48-timmarsfristen och 7-dagarsfristen kan provas direkt. Där finns också utkorgen (all e-post
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
| A2, AC-101.3, AC-101.5, BR-02, BR-07, BR-08, BR-17 | Skapa match i Spår 2 |
| FR-A-102, AC-102.2/102.3 | Börsen med filter, gäster ser inga kontaktuppgifter |
| A6, FR-A-103, BR-09, BR-15, BR-16 | Intresseanmälan, val, tillbakadragande, kappslöpning |
| A7, FR-A-104, BR-04 | Återbud (akut e-post, röd flagga) |
| A8, A9, FR-A-105, BR-10 | Avbokning, ingen redigering |
| A12, FR-A-106 | Utgång utan motståndare vid starttid |
| A13, A14, FR-A-107, BR-14 | "Match genomförd" inom 48 h, påminnelser vid sluttid och +24 h |
| C1–C5, FR-C-301–303, BR-05, BR-13 | Blind Fair Play-recension, lagprofil (median, snitt, min 3) |
| FR-U-001–003 | Google-inloggning, lagprofiler, kansliets godkännande |
| FR-B-207 | Masterdata för anläggningar och planer |
| 4.0, NFR-05/06/07 | Outbox, idempotens, ordning, revisionslogg, tidszon |
| Avsnitt 9 | Notifieringar #1, 2, 6–10, 14–18 |

**Inte med i utkastet:** Spår 1 och Process B (kö för helgtider, 14-dagarsregeln, inställning från kansliet),
radering av personuppgifter (FR-U-004) och en riktig e-postleverantör. Typerna, routingen och
eventutskicken för Spår 1 (`RESERVATION_ACCEPTED`, `RESERVATION_WITHDRAWN`, `MATCH_EXPIRED`) finns redan
i Process A, så Process B kan läggas till som en ny mottagare i dispatchern.

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

## Tekniska val

- **SQLite via `node:sqlite`** ger en körbar MVP utan installationer. Modulen är markerad som experimentell
  i Node 22. All SQL är standard och transaktionerna är korta, så ett byte till PostgreSQL påverkar bara
  `infra/db.ts` och några `INSERT OR IGNORE`.
- **Express 5 + React 19 (Vite)**, TypeScript i hela kedjan. Klienten importerar bara typer från servern.
- **Sessioner** i databasen med httpOnly-cookie (`SameSite=Lax`). Ändrande anrop måste ha `Content-Type: application/json`,
  vilket stoppar enkel CSRF via formulär.
