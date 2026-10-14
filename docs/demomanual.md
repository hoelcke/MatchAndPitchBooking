# Demomanual – Matchbörsen

För dig som demonstrerar Matchbörsen. Nio scenarier som visar appen från tom börs till Fair Play, med
klick, testanvändare och vad du säger. Manualen bygger på testdatan i `src/server/seed.ts` och
knapptexterna i `src/web/`. Uppdatera den när någon av dem ändras.

Kör scenarierna i ordning. De tre sista flyttar serverns klocka framåt med tidsmaskinen, och det går inte
att backa utan att göra om förberedelserna.

## Demokarta

Minuterna är ett förslag för en demo på ungefär en halvtimme. Har du bara tio minuter: kör 3, 5 och 8.

| # | Scenario | Logga in som | Minuter | Klocka |
| :-- | :-- | :-- | :-- | :-- |
| 1 | Gästen ser börsen | Utloggad | 2 | Nu |
| 2 | Behörighet och godkännande | Per Pending, Karin Kansli | 3 | Nu |
| 3 | Spår 2: egen träningstid | Lena Lidingö | 3 | Nu |
| 4 | Spår 1: helgtid via kansliet | Lena, Karin | 5 | Nu |
| 5 | Intresse och val av motståndare | Lena, Anna Lind | 4 | Nu |
| 6 | Återbud och nytt val | Anna, Erik Djurman, Lena | 4 | Nu |
| 7 | Match genomförd | Lena | 2 | +6 dagar |
| 8 | Fair Play och lagprofil | Lena, Erik, Adam Admin | 4 | +6 dagar |
| 9 | 14-dagarsregeln (valfritt) | Fia Flicktränare, Karin | 3 | +14–21 dagar |

## Förberedelser (10 minuter innan)

I terminalen:

```bash
git pull origin main
npm install
npm run seed      # återskapar databasen med testdata, allt från förra demon försvinner
npm run dev
```

I webbläsaren:

- Två fönster med http://localhost:5173: ett vanligt och ett inkognito, så att två användare är inloggade
  samtidigt.
- En flik med `/dev` för utkorgen och tidsmaskinen.
- Chrome eller Edge på svenska. VS Codes inbyggda webbläsare visar datum som MM/DD och tid med AM/PM.
- Kontroll: börsen visar fyra matcher.

## Testanvändare

Logga in via **Logga in → Testanvändare** (finns bara i dev).

| Användare | Roll och lag | Scenario |
| :-- | :-- | :-- |
| Lena Lidingö | Ledare, IFK Lidingö P2015 Blå, godkänd | 3, 4, 5, 6, 7, 8 |
| Fia Flicktränare | Ledare, IFK Lidingö F2014, godkänd | 9 |
| Per Pending | Ledare, väntar på kansliet | 2 |
| Anna Lind | Hammarby IF P2015-11, externt lag | 5, 6 |
| Erik Djurman | Djurgårdens IF P2016, externt lag | 6, 8 |
| Karin Kansli | Kansli | 2, 4, 9 |
| Adam Admin | Administratör | 8 |

Sara Täby och Nora Ny finns också i testdatan. Nora passar om kunden vill se hur en ny ledare skapar ett lag.

## Scenario 1 · Gästen ser börsen (2 min)

**Logga in som:** ingen, utloggad.

1. Öppna inkognitofönstret utan att logga in.
2. Börsen: fyra matcher med tid, ålder, spelform, nivå och plats.
3. **Filtrera** → födelseår 2016: bara matcher som ett P2016-lag kan anmäla sig till.
4. Öppna en match: inga kontaktuppgifter, och "Logga in för att anmäla intresse".
5. Klicka på IFK Lidingö P2015 Blå: lagprofilen med nivå och Fair Play.

**Säg:** "Börsen är öppen för alla lag i regionen. Kontaktuppgifter syns först när lagen valt varandra."

**Visar:** AC-102.2 filter, AC-102.3 inga kontaktuppgifter för gäster, BR-09 ±1 år, AC-303.2 lagprofil.

> Filtret visar matcher som är öppna för ett år yngre eller äldre, inte bara exakt samma år. Lagprofilen syns
> bara för lag med minst tre recensioner, och Lenas lag har det i testdatan.

## Scenario 2 · Behörighet och godkännande (3 min)

**Logga in som:** Per Pending, sedan Karin Kansli.

1. Logga in som Per Pending.
2. **Skapa match**: meddelandet att kopplingen väntar på kansliet.
3. Logga ut och in som Karin Kansli → **Kansli**.
4. Under **Ledarkopplingar att godkänna**: **Godkänn** Per.
5. Scrolla ner: anläggningar och planer, med spelformer per plan.

**Säg:** "Bara ledare som kansliet godkänt kan skapa matcher i klubbens namn."

**Visar:** BR-08 godkännande, AC-101.5 nekad match, FR-U-003 kansliets beslut, FR-B-207 masterdata.

> Externa lag behöver inget godkännande, de kan bara anmäla intresse.

## Scenario 3 · Spår 2: egen träningstid (3 min)

**Logga in som:** Lena Lidingö.

1. **Skapa match**. Spår 2 är förvalt.
2. Välj Skärsätra IP, Plan 2.
3. Datum om några dagar, starttid 18:00, längd 60: "Slutar 19:00".
4. Fyll i matchställ och telefon → **Publicera på börsen**.
5. Matchsidan visar "Söker motståndare". Visa att matchen ligger på börsen.

**Säg:** "Laget har redan sin tid. Ingen förfrågan till kansliet, matchen ligger ute på en minut."

**Visar:** A2 publiceras direkt, AC-101.3, BR-02 ingen validering mot kansliet, BR-17 telefon krävs.

> Ålder och kategori förifylls från laget. En plan som inte är registrerad för spelformen ger bara en
> varning. En publicerad match kan inte ändras, bara avbokas (BR-10).

## Scenario 4 · Spår 1: helgtid via kansliet (5 min)

**Logga in som:** Lena och Karin, ett fönster var.

1. Lena → **Skapa match** → **Spår 1**.
2. Välj en fredag: "Träningsmatchtider tilldelas endast under helger".
3. Välj datumet i tipset "Tidigast lördag …", 10:00, 90 min → **Skicka förfrågan till kansliet**.
4. Matchsidan: "Plan begärd". Matchen syns inte på börsen.
5. Karin → **Kansli** → **Förfrågningar om helgtider**: välj plan → **Tilldela plan**.
6. Lena: matchen ligger på börsen, med "Välj motståndare senast …".

**Säg:** "Kansliet får en kö, inte ett mejl. Fristen följer med automatiskt."

**Visar:** A1, BR-01 helg, BR-06 21 dagar, B2 tilldelning, AC-201.2 rätt planer, A3 publicering.

> Planlistan visar bara planer som klarar spelformen. Varningen för dubbelbokning visas om du tilldelar
> Lenas andra förfrågan i kön, den som redan fanns i testdatan, samma plan och tid. **Avslå** visar att
> orsaken går till laget.

## Scenario 5 · Intresse och val av motståndare (4 min)

**Logga in som:** Lena och Anna Lind.

1. Lena → **Mina matcher** → matchen om fem dagar kl 17:30, med två anmälningar.
2. Visa anmälningarna från Hammarby och Djurgården, med lagprofil.
3. **Välj** Hammarby IF → status "Motståndare klar".
4. Anna, i andra fönstret: hemmalagets telefon och e-post syns nu.
5. `/dev` → **Utkorg**: e-post till båda lagen, och "Annat lag valdes" till Erik.

**Säg:** "Ett klick, och båda lagen har varandras kontaktuppgifter. Den som inte valdes får besked direkt."

**Visar:** A6 val, BR-15 direkt bekräftelse, AC-103.2 kontaktuppgifter, notiser #7 och #8.

> Matchen och anmälningarna finns redan i testdatan. Drar ett lag tillbaka sin anmälan samtidigt som
> hemmalaget väljer, stoppas valet med ett tydligt meddelande (BR-16, AC-103.4).

## Scenario 6 · Återbud och nytt val (4 min)

**Logga in som:** Anna, Erik Djurman och Lena.

1. Anna → samma match → **Lämna återbud**.
2. Lena: matchen är tillbaka på börsen med "Brådskande" och röd kant.
3. `/dev` → **Utkorg**: akut e-post "ÅTERBUD" till hemmalaget.
4. Erik → matchen → **Anmäl intresse** igen, med telefonnummer.
5. Lena → **Välj** Djurgårdens IF.

**Säg:** "Ingen ringer runt. Matchen syns direkt som brådskande, och den som fick nej kan anmäla sig igen."

**Visar:** A7 återbud, AC-104.2 röd flagga, BR-04 kansliet störs inte, notis #9 akut.

> Erik spelar med ett lag som är ett år yngre, och matchen är öppen för det. Kansliet blir inte inblandat
> vid återbud, bokningen står kvar.

## Scenario 7 · Match genomförd (2 min, tidsmaskin)

**Logga in som:** Lena Lidingö.

1. Lena → matchen mot Djurgården: **Match genomförd** är gråad före sluttid.
2. `/dev` → **Tidsmaskin**: klicka **+2 d** tre gånger, alltså sex dagar fram.
3. **Utkorg**: påminnelse till hemmalaget om att bekräfta.
4. Lena → matchen → **Match genomförd** → status "Genomförd".
5. **Utkorg**: Fair Play-inbjudan till båda lagen.

**Säg:** "Hemmalaget bekräftar inom 48 timmar efter matchen. Glömmer de får de påminnelser."

**Visar:** A13 bekräftelse, BR-14 48 timmar, AC-107.3 påminnelser, C1 Fair Play startar.

> Sex dagar fram hamnar alltid efter matchens sluttid och inom 48 timmar, oavsett tid på dygnet. Klicka
> inte **+7 d**, då har fristen gått ut och matchen blir "Utgången" (A14).

## Scenario 8 · Fair Play och lagprofil (4 min, tidsmaskin)

**Logga in som:** Lena, Erik och Adam Admin.

1. Lena → **Fair Play** → betygsätt Djurgården: spelare, ledare, publik och nivå → **Skicka recension**.
2. Visa att recensionen väntar på motparten och inte räknas än.
3. Erik → **Fair Play** → betygsätt IFK Lidingö P2015 Blå → **Skicka recension**.
4. Båda räknas in. Lenas lagprofil har nu fyra recensioner.
5. Adam Admin → **Admin**: de enskilda recensionerna.

**Säg:** "Blint och utan fritext. Lagen ser bara snittet, och bara administratören ser enskilda svar."

**Visar:** C2 formulär, C3 räknas in samtidigt, BR-05 blind, BR-13 lagprofil, AC-302.4 admin.

> Djurgårdens lagprofil visar fortfarande "Ingen lagprofil än", eftersom den visas först från tre
> recensioner. Ett enda dåligt betyg kan alltså inte ge ett lag ett dåligt rykte.

## Scenario 9 · 14-dagarsregeln (3 min, tidsmaskin, valfritt)

**Logga in som:** Fia Flicktränare, sedan Karin.

1. Fia → **Mina matcher** → helgmatchen om ungefär en månad: "Välj motståndare senast …".
2. `/dev` → **Tidsmaskin**: klicka **+7 d** tills datumet i fristen har passerat, oftast två gånger.
3. **Utkorg**: påminnelsen 18 dagar före, och sedan "Matchen är inställd".
4. Fia → matchen: status "Avbokad", plantiden är återkallad.
5. Karin → **Kansli**: bokningen ligger under **Avslutade** som återkallad.

**Säg:** "Kansliet behöver aldrig jaga tränare. Plantiden frigörs av sig själv."

**Visar:** BR-03 fristen, B7 automatisk återkallelse, AC-202.1 påminnelse, A10 matchen ställs in.

> Efter det här scenariot är klockan långt fram. Gör förberedelserna igen före nästa demo.

## Om något strular

| Du ser | Gör så här |
| :-- | :-- |
| Tom sida | Hämta senaste `main` och ladda om med Ctrl+F5. |
| Gammal eller konstig testdata | Stoppa servern, kör `npm run seed` och sedan `npm run dev`. |
| AM/PM eller MM/DD | Byt till Chrome eller Edge på svenska. |
| Klockan har gått för långt | `/dev` → **Återställ**, sedan `npm run seed`. |
| "Matchen har ändrats av någon annan" | Ladda om sidan. Visa det gärna: skyddet mot dubbla klick (BR-16). |
| Ingen e-post kommer fram | Rätt: e-posten loggas i utkorgen på `/dev` och skickas inte på riktigt. |

Stoppar du servern i PowerShell med Ctrl+C och frågan "Terminate batch job (Y/N)?" kommer: svara inte, den
stänger av sig självt.

## Avslut

Knyt ihop i tre meningar:

1. Tränaren hittar motstånd på en minut, utan att ringa runt.
2. Kansliet får en kö och fristerna sköter sig själva.
3. Fair Play gör nästa match bättre för alla.

Fråga sedan: vilket av det ni såg skulle göra mest skillnad för er? Gå vidare till pilotförslaget i
säljpresentationen.
