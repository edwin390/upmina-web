# Datenschutzerklärung — ENTWURF v0.3 (unveröffentlicht · Arbeitsübersetzung · rechtliche Prüfung ausstehend)

> Arbeitsübersetzung von `AVISO-DE-PRIVACIDAD.borrador.md` (bis zur Prüfung gilt der spanische Text als Referenz). Keine Rechtsberatung; es wird weder die Einhaltung des mexikanischen Rechts (LFPDPPP) noch der EU-DSGVO zugesichert. `[AUSSTEHEND]` muss der Verantwortliche liefern oder entscheiden; nichts wurde erfunden. Rechtsgrundlagen und Speicherfristen sind **Vorschläge** zur fachlichen Prüfung.

## 1. Verantwortlicher
- Verantwortlicher: eine in Mexiko ansässige natürliche Person, die UPMINA Web privat betreibt (kein Unternehmen). Rechtliche Identität: `[AUSSTEHEND]`.
- Offizieller Kontakt für Datenschutz, Ausübung von Rechten und rechtliche Angelegenheiten: **upminaaweb@gmail.com**.
- Erforderliche Anschrift oder Zustellungsweg: `[AUSSTEHEND: rechtliche Prüfung; eine private Wohnanschrift wird nicht veröffentlicht, ohne die geltenden Pflichten zu prüfen]`.
- Identifikation und internationale Pflichten: `[AUSSTEHEND: Anforderungen an die Identifikation und mögliche Pflichten beim internationalen Angebot prüfen (z. B. EU-Vertreter oder Datenschutzbeauftragter, DSGVO Art. 3, 27, 37); es wird keine behauptet]`.
- UPMINA Web ist ein **unabhängiges, von Fans geschaffenes Projekt**; es ist nicht offiziell mit UPMINA oder ihrem Team verbunden und wird von ihnen weder gesponsert noch unterstützt.

## 2. Welche Daten wir verarbeiten
| Kontext | Daten | Quelle |
|---|---|---|
| Surfen (ohne Konto) | Technische Verbindungsdaten (IP, Browser, Seiten, Zeit) bei der Hosting-Infrastruktur | Automatisch |
| Konto | E-Mail-Adresse (bestätigt), Passwort (vom Authentifizierungsanbieter verwahrt) | Du |
| Profil | Benutzername (öffentlich), Anzeigename (öffentlich), Bio und Avatar, falls du sie angibst | Du |
| Community | Texte, Fotos und Videos, die du veröffentlichst (öffentlich, mit Benutzername und Datum); „Gefällt mir“ | Du |
| Meldungen | Von dir gesendete Meldungen (Grund, Erläuterung bis 1000 Zeichen), mit deinem Konto verknüpft; anderen Nutzern nicht sichtbar | Du |
| Moderation | Fälle, Entscheidungen, Sanktionen (Strikes), Mitteilungen, Prüfprotokolle zu Inhalten oder Konten | Team |
| Urheberrecht | Anspruchsteller: Name, E-Mail, Organisation und Beziehung zum Werk, Beschreibungen, Belegverweise, Erklärung und Unterschrift. Betroffene Autoren: Mitteilungen, Widersprüche und Kontakt für den Widerspruch | Anspruchsteller / Autor |
| Team (Moderation/Verwaltung) | Faktoren der Mehr-Faktor-Authentifizierung, Rollen und Aktionsprotokolle | Team |
| Kontolöschung | Interne Kennung, Status und Daten des Vorgangs (ohne E-Mail oder Token) | System |

Wir verarbeiten nicht absichtlich sensible Daten und fragen weder nach Geburtsdatum noch nach Ausweisdokumenten. Was du freiwillig schreibst oder hochlädst, liegt in deiner Verantwortung. **Minderjährige:** siehe Abschnitt 9.

## 3. Zwecke und Rechtsgrundlagen (Vorschlag)
| Zweck | Grundlage (DSGVO, Vorschlag) | Erforderlich |
|---|---|---|
| Konto erstellen und authentifizieren; Verifizierungs-, Wiederherstellungs- und Sicherheits-E-Mails (inkl. MFA) | Erfüllung des gewünschten Dienstes | Ja |
| Profil und Beiträge anzeigen; „Gefällt mir“ | Erfüllung des Dienstes | Ja |
| Inhalte moderieren, Regeln und Strikes anwenden; Meldungen bearbeiten | Berechtigtes Interesse an einem sicheren Raum | Ja |
| Urheberrechtsansprüche und Widersprüche bearbeiten | Berechtigtes Interesse; ggf. rechtliche Verpflichtung `[AUSSTEHEND]` | Ja |
| Sicherheit, Missbrauchsprävention und Prüfprotokolle | Berechtigtes Interesse | Ja |
| Löschantrag bearbeiten und Mindestnachweise aufbewahren | Berechtigtes Interesse / rechtliche Verpflichtung `[AUSSTEHEND]` | Ja |

Derzeit gibt es **keine optionalen Zwecke** (Marketing, Profiling, Analyse, Newsletter, Werbung). Würden sie eingeführt, bräuchten sie eine gesonderte, widerrufbare Einwilligung. Für das LFPDPPP: `[AUSSTEHEND: prüfen, ob für eine Verarbeitung eine ausdrückliche Einwilligung nötig ist]`.
Wir treffen keine automatisierten Entscheidungen mit rechtlicher Wirkung: Jede Sanktion entscheidet ein Mensch.

## 4. Dienstleister und internationale Übermittlungen
| Anbieter | Funktion | Daten | Standort |
|---|---|---|---|
| Vercel | Hosting und Funktionen | Technische Verbindungsdaten | `[AUSSTEHEND: Region]` |
| Supabase | Datenbank und Authentifizierung | Konto, Profil, Inhalte, Moderation | `[AUSSTEHEND: Projektregion]` |
| Cloudflare (R2 und Auslieferung) | Fotos/Videos speichern und ausliefern | Community-Dateien, Verbindungsdaten | `[AUSSTEHEND]` |
| Resend | Transaktions-E-Mails | E-Mail-Adresse und Nachrichteninhalt | `[AUSSTEHEND]` |
| Google Fonts | Schriftarten | IP-Adresse des Browsers | `[AUSSTEHEND]` |
| Twitch, YouTube, Instagram, TikTok | Eingebettete Inhalte, Vorschaubilder und öffentliche Kanaldaten | Technische Daten, die dein Browser beim Laden sendet | je Anbieter |

Der Dienst ist international und mehrere Anbieter arbeiten außerhalb Mexikos und der EU: Es gibt internationale Übermittlungen. `[AUSSTEHEND: je Anbieter Rolle (Auftragsverarbeiter / Verantwortlicher), Übermittlungsinstrument (z. B. Standardvertragsklauseln, EU-US-Datenschutzrahmen, falls zertifiziert) und anwendbare Klauseln.]` Wir verkaufen keine personenbezogenen Daten.

## 5. Cookies und lokaler Speicher
Wir setzen keine eigenen Cookies und nutzen weder Analyse noch Werbung. Wir verwenden den lokalen Speicher des Browsers für deine Sprache und, wenn du dich anmeldest, für die Sitzung. Eingebettete Inhalte Dritter können eigene Cookies verwenden (siehe deren Hinweise). `[AUSSTEHEND: nach technischer Prüfung der Einbettungen klären, ob in der EU ein Einwilligungsbanner nötig ist]`.

## 6. Speicherung und Löschung
### 6.1 Kontolöschung (aktuelles Verhalten)
1. Du beantragst die Löschung unter „Konto“ bei angemeldeter Sitzung und bestätigst per Link, der an deine E-Mail-Adresse gesendet wird (30 Minuten gültig, einmalig).
2. Mit der Bestätigung wird dein Zugang **sofort und unwiderruflich gesperrt**; Sitzungen werden beendet.
3. Die Bereinigung beginnt und kann **asynchron** weiterlaufen: Sie entfernt dein Profil, Beiträge, „Gefällt mir“, hochgeladene Dateien und deine Zugangsdaten. **Wir behaupten nicht, dass alles sofort verschwindet.**
4. Schlägt ein Schritt fehl, **bleibt das Konto gesperrt** und die Bereinigung bleibt offen; ein Bereinigungsfehler stellt den Zugang nie wieder her.
5. Fehler werden protokolliert und lösen Warnungen für das technische Team (Rolle Developer) aus. Eine fehlgeschlagene Bereinigung **kann heute einen manuellen Neuversuch** durch dieses Team erfordern. **Wir versprechen keine unbeaufsichtigten automatischen Wiederholungen.**
6. Dein Benutzername wird wieder frei, ohne dass jemand etwas von deinem Konto erbt. Konten mit Teamrolle werden nicht per Selbstbedienung gelöscht.

### 6.2 Was gelöscht und was aufbewahrt wird
- **Gelöscht** (in der obigen Bereinigung): Profil, Beiträge, „Gefällt mir“, ausschließlich von deinen Beiträgen genutzte Dateien und die Zugangsidentität. Mit einer anderen Ressource geteilte Dateien bleiben bis zur Freigabe bestehen.
- **Aufbewahrt**, mit eingeschränktem Zugriff, nicht öffentlich und mit einer internen Kennung verknüpft: Meldungen, Moderationsfälle und -entscheidungen, Strikes (die, solange das Konto besteht, zur Anwendung des Sanktionssystems dienen), Moderationsprotokolle, Urheberrechtsansprüche und Widersprüche (einschließlich des Widerspruchskontakts, nicht anonymisiert) sowie der Löschvorgang (ohne E-Mail oder Token). **Es gibt heute weder eine festgelegte Aufbewahrungsfrist noch eine automatische Löschung dieser Daten, und wir versprechen keine Löschfristen.** `[AUSSTEHEND: rechtliche Prüfung, ob und wie lange sie aufbewahrt werden müssen]`
- Das Löschtoken (nur sein Hash) läuft nach 30 Minuten ab.

### 6.3 Bestehende Kopien
Sicherungskopien und manuelle Kopien der Datenbank, eigene oder die unserer Anbieter, können existieren und Daten bereits gelöschter Konten enthalten. Sie werden nicht sofort oder automatisch gelöscht, und wir versprechen keinen Rotationsplan. `[AUSSTEHEND: mit den Anbietern klären]`

### 6.4 Ausnahmen
Wir können Daten aufbewahren, wenn es nötig ist, um eine rechtliche Pflicht zu erfüllen, einen Anspruch zu bearbeiten oder zu verteidigen, einen Sicherheitsvorfall zu untersuchen oder Missbrauch zu verhindern – begründet und begrenzt. `[AUSSTEHEND: rechtliche Prüfung]`

### 6.5 Von UPMINA Web verwaltete Daten und von Dritten verarbeitete Daten
Das Obige beschreibt die Daten, die UPMINA Web direkt speichert (Datenbank, Dateien). Anbieter (Hosting, Datenbank, Speicher, E-Mail und Inhaltsplattformen) bewahren Daten nach ihren eigenen Richtlinien und Fristen auf `[AUSSTEHEND: prüfen]`.

## 7. Rechte
- **Mexiko (ARCO):** Zugang, Berichtigung, Löschung und Widerspruch; Widerruf der Einwilligung.
- **EU (DSGVO):** zusätzlich Einschränkung, Übertragbarkeit, Widerspruch gegen Verarbeitung aufgrund berechtigten Interesses und Beschwerde bei der Aufsichtsbehörde deines Landes.

Zur Ausübung schreibe an **upminaaweb@gmail.com** mit Benutzername, Konto-E-Mail und deinem Anliegen (wir können die zur Identitätsprüfung nötigen Mindestangaben verlangen). Profilbearbeitung und Kontolöschung sind direkt auf der Website möglich. Antwortfrist: `[AUSSTEHEND: gesetzliche Fristen]`. Mexikanische Behörde: `[AUSSTEHEND: aktuell zuständige Behörde bestätigen]`.

## 8. Sicherheit
Authentifizierung durch einen spezialisierten Anbieter, eingeschränkter Zugriff auf Moderationsdaten, verpflichtende Mehr-Faktor-Authentifizierung für Teamrollen und Prüfprotokolle. Kein System ist unfehlbar. `[AUSSTEHEND: Verfahren und Frist zur Meldung von Vorfällen]`.

## 9. Minderjährige
- **Unter 13 Jahren:** dürfen kein Konto erstellen. Sie können die öffentlichen, für alle Zielgruppen geeigneten Inhalte der Website ansehen.
- **13 bis 17 Jahre:** Die Registrierung hängt von den im jeweiligen Land geltenden rechtlichen Pflichten ab, einschließlich der Zustimmung der Eltern oder Erziehungsberechtigten, soweit erforderlich. **Das Alter von 13 Jahren genügt für sich allein nicht, um sich in jedem Land rechtmäßig zu registrieren.**
- **Aktueller Stand:** Die Registrierung **prüft weder das Alter noch elterliche Zustimmungen**; diese Maßnahmen sind noch nicht umgesetzt, und wir behaupten nicht, dass sie existieren. Wir fragen weder nach vollständigen Geburtsdaten noch nach Ausweisdokumenten.
- **Öffentliche Profile und Beiträge:** Dein Profil (Benutzername, Name, Bio und Avatar, falls du sie angibst) und deine Beiträge sind **öffentlich**; es gibt keine privaten Profile und keine Altersangaben, und wir kennzeichnen niemanden öffentlich als minderjährig. Wir empfehlen, keine personenbezogenen Daten in Profil oder Beiträgen anzugeben, besonders als Minderjährige(r).
- Erkennen wir ein Konto einer Person unter 13, schließen wir es und löschen die Daten.
- Wir nutzen keine Werbung, kein Tracking und kein Profiling – weder bei Minderjährigen noch bei anderen.
- Grundsätze: Datenminimierung und Privatsphäre. Weitere Maßnahmen für Minderjährige sind **nicht umgesetzt**.

## 10. Änderungen
Wir veröffentlichen jede Änderung mit Datum und Version und benachrichtigen bei wesentlichen. Version v0.3 · Datum `[AUSSTEHEND bei Veröffentlichung]`.
