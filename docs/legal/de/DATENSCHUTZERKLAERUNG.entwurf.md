# Datenschutzerklärung — ENTWURF v0.2 (unveröffentlicht · Arbeitsübersetzung · rechtliche Prüfung ausstehend)

> Arbeitsübersetzung von `AVISO-DE-PRIVACIDAD.borrador.md` (bis zur Prüfung gilt der spanische Text als Referenz). Keine Rechtsberatung; es wird weder die Einhaltung des mexikanischen Rechts (LFPDPPP) noch der EU-DSGVO zugesichert. `[AUSSTEHEND]` muss der Verantwortliche liefern oder entscheiden; nichts wurde erfunden. Rechtsgrundlagen und Speicherfristen sind **Vorschläge** zur fachlichen Prüfung.

## 1. Verantwortlicher
- Verantwortlicher: natürliche Person `[AUSSTEHEND: vollständiger Name]`, wohnhaft in Mexiko, die UPMINA Web privat betreibt (kein Unternehmen).
- Postalische Kontaktangabe, falls gesetzlich erforderlich: `[AUSSTEHEND: festlegen, was rechtlich nötig und veröffentlichbar ist]`.
- Kontakt für Datenschutz und Betroffenenrechte: `[AUSSTEHEND: eigene E-Mail-Adresse]`.
- UPMINA Web ist ein **unabhängiges, von Fans geschaffenes Projekt**; es ist nicht offiziell mit UPMINA oder ihrem Team verbunden und wird von ihnen weder gesponsert noch unterstützt.
- EU-Vertreter / Datenschutzbeauftragter: `[AUSSTEHEND: prüfen, ob erforderlich (DSGVO Art. 3, 27, 37); es wird keine Pflicht behauptet]`.

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
- Du kannst die dauerhafte Löschung deines Kontos unter „Konto“ beantragen: E-Mail-Link (30 Minuten gültig, einmalig), Anmeldung und Bestätigung. Sie ist **unwiderruflich**: Mit der Bestätigung wird der Zugang gesperrt, und ein Hintergrundprozess entfernt Profil, Beiträge, „Gefällt mir“, Dateien und Zugangsdaten. Dein Benutzername wird wieder frei, ohne dass jemand etwas erbt.
- **Aufbewahrt** werden, mit eingeschränktem Zugriff, nicht öffentlich und mit einer internen Kennung verknüpft: Meldungen, Fälle und Entscheidungen, Strikes, Urheberrechtsansprüche und Widersprüche, Prüfprotokolle und der Löschvorgang selbst. Zweck: Sicherheit, Verteidigung gegen Ansprüche und Nachvollziehbarkeit.
- **Fristen:** `[AUSSTEHEND: Der Code legt KEINE Fristen fest; der Verantwortliche muss sie je Kategorie festlegen und begründen]`.
- **Grenzen:** Backups der Anbieter und bereits ausgestellte signierte URLs können bis zum Ablauf bestehen bleiben; Caches können alte Inhalte einige Minuten anzeigen. Konten mit Teamrolle können nicht per Selbstbedienung gelöscht werden.
- Kontakt für Urheberrechts-Widersprüche: wird derzeit aufbewahrt; `[AUSSTEHEND: Anonymisierungsrichtlinie]`.

## 7. Rechte
- **Mexiko (ARCO):** Zugang, Berichtigung, Löschung und Widerspruch; Widerruf der Einwilligung.
- **EU (DSGVO):** zusätzlich Einschränkung, Übertragbarkeit, Widerspruch gegen Verarbeitung aufgrund berechtigten Interesses und Beschwerde bei der Aufsichtsbehörde deines Landes.

Zur Ausübung schreibe an `[AUSSTEHEND: E-Mail]` mit Benutzername, Konto-E-Mail und deinem Anliegen (wir können die zur Identitätsprüfung nötigen Mindestangaben verlangen). Profilbearbeitung und Kontolöschung sind direkt auf der Website möglich. Antwortfrist: `[AUSSTEHEND: gesetzliche Fristen]`. Mexikanische Behörde: `[AUSSTEHEND: aktuell zuständige Behörde bestätigen]`.

## 8. Sicherheit
Authentifizierung durch einen spezialisierten Anbieter, eingeschränkter Zugriff auf Moderationsdaten, verpflichtende Mehr-Faktor-Authentifizierung für Teamrollen und Prüfprotokolle. Kein System ist unfehlbar. `[AUSSTEHEND: Verfahren und Frist zur Meldung von Vorfällen]`.

## 9. Minderjährige
- **Unter 13 Jahren:** dürfen kein Konto erstellen. Sie können die öffentlichen Inhalte der Website ansehen. Erkennen wir ein Konto einer Person unter 13, schließen wir es und löschen die Daten.
- **13 bis 17 Jahre:** dürfen sich registrieren, vorbehaltlich der rechtlichen Bedingungen ihres Landes, einschließlich der Zustimmung der Eltern oder Erziehungsberechtigten, wenn das Gesetz sie verlangt. **Das Alter von 13 Jahren genügt für sich allein nicht, um sich in jedem Land rechtmäßig zu registrieren.**
- Die Registrierung fragt das Alter derzeit **nicht** ab und prüft es nicht; die Maßnahmen (Altersangabe, Elternzustimmung, datenschutzfreundliche Voreinstellungen) sind **vorgeschlagen, nicht umgesetzt** (siehe `MENORES-EVALUACION.md`).
- Wir nutzen keine Werbung, kein Tracking und kein Profiling – weder bei Minderjährigen noch bei anderen.

## 10. Änderungen
Wir veröffentlichen jede Änderung mit Datum und Version und benachrichtigen bei wesentlichen. Version v0.2 · Datum `[AUSSTEHEND bei Veröffentlichung]`.
