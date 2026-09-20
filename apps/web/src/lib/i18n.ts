/**
 * Learner facing strings. Hindi first. Every string a learner can see goes through `t`,
 * no exceptions, so adding a language is one dictionary and not a retrofit.
 */

export type Lang = 'hi' | 'en';

const hi = {
  appName: 'चौकन्ना',
  switchLanguage: 'English',
  practiceBadge: 'यह सिर्फ़ अभ्यास है',

  consentTitle: 'ठगी से बचने का अभ्यास',
  consentGreeting: '{name} जी, नमस्ते।',
  consentIntro: 'आपके परिवार ने आपके लिए अभ्यास कॉल शुरू करनी चाही हैं। आपकी हाँ के बिना कुछ नहीं होगा।',
  consentPointCalls: 'कभी-कभी आपको एक अभ्यास कॉल आएगी जो ठग की तरह बात करेगी। वह कभी असली नहीं होगी।',
  consentPointAudio: 'अभ्यास कॉल की आवाज़ 7 दिन बाद अपने-आप मिट जाएगी।',
  consentPointFamily: 'आपके परिवार को सिर्फ़ नतीजा दिखेगा, आपकी बातें नहीं।',
  consentPointStop: 'आप किसी भी समय सारी अभ्यास कॉल बंद कर सकते हैं।',
  consentSayThis: 'नीचे का बटन दबाइए और यह वाक्य बोलिए:',
  consentSentence: 'हाँ, मैं अभ्यास कॉल के लिए तैयार हूँ।',
  consentPrimary: 'हाँ, मैं तैयार हूँ',
  consentMicAsk: 'ऊपर दिख रहे सवाल में माइक्रोफ़ोन की अनुमति दीजिए।',
  consentRecording: 'अब बोलिए… {seconds}',
  consentSaving: 'सहेज रहे हैं…',
  consentMicDenied: 'माइक्रोफ़ोन नहीं चल पाया। कोई बात नहीं, नीचे "हाँ" लिखकर पुष्टि कीजिए।',
  consentTypedLabel: 'यहाँ "हाँ" लिखिए',
  consentTypedConfirm: 'पुष्टि करें',
  consentTypedInvalid: 'कृपया "हाँ" लिखिए।',
  consentDone: 'धन्यवाद! आपकी हाँ सहेज ली गई है।',

  inviteInvalidTitle: 'यह लिंक अब काम नहीं करता',
  inviteInvalidBody: 'अपने परिवार से नया लिंक माँगिए।',

  stopAll: 'सारी अभ्यास कॉल बंद करें',
  stopAllConfirm: 'सारी अभ्यास कॉल बंद कर दी गई हैं।',
  stopping: 'बंद कर रहे हैं…',

  windowTitle: 'अभ्यास कॉल कब आ सकती है?',
  windowHelp: 'इस समय के बीच किसी भी समय, हफ़्ते में ज़्यादा से ज़्यादा एक बार।',
  windowDays: 'दिन',
  windowFrom: 'कब से',
  windowTo: 'कब तक',
  windowSave: 'सहेजें',
  windowSaved: 'समय सहेज लिया गया।',
  windowInvalid: 'कम से कम एक दिन चुनिए, और समय कम से कम एक घंटे का रखिए।',
  windowSummary: '{days}, {start} से {end} तक',
  day1: 'सोम',
  day2: 'मंगल',
  day3: 'बुध',
  day4: 'गुरु',
  day5: 'शुक्र',
  day6: 'शनि',
  day7: 'रवि',

  homeGreeting: 'नमस्ते {name} जी',
  statusActive: 'अभ्यास कॉल चालू हैं',
  statusPaused: 'अभ्यास कॉल बंद हैं',
  statusRevoked: 'आपने अपनी हाँ वापस ले ली है',
  statusInvited: 'अभी आपकी हाँ बाकी है',
  homeWindowLabel: 'अभ्यास कॉल का समय',
  homeChangeWindow: 'समय बदलें',
  homeResume: 'अभ्यास कॉल फिर से चालू करें',
  homeWithdraw: 'अपनी हाँ वापस लें',
  homeWithdrawDone: 'आपकी हाँ वापस ले ली गई है।',
  homeNoSession: 'यह पन्ना खोलने के लिए अपने परिवार के भेजे लिंक से आइए।',
  homeCallWaiting: 'एक अभ्यास कॉल आपका इंतज़ार कर रही है',
  homeSharingLabel: 'मेरे परिवार को पढ़ने दें कि अभ्यास में मैंने क्या कहा',
  homeSharingHelp: 'अभी सिर्फ़ आप ही पढ़ सकते हैं। आप जब चाहें बदल सकते हैं।',
  homeSharingOn: 'परिवार आपकी बातें पढ़ सकता है',
  homeSharingOff: 'आपकी बातें सिर्फ़ आपकी हैं',
  homeSharingAllow: 'परिवार को पढ़ने दें',
  homeSharingStop: 'पढ़ना बंद करें',
  homeOpenCall: 'अभ्यास कॉल खोलें',

  // The drill. The realism is in the conversation, never in the screen: it always says this is
  // practice, and the way out is always the biggest thing on it.
  drillRingingTitle: 'अभ्यास कॉल आ रही है',
  drillRingingCaller: 'अनजान नंबर',
  drillAnswer: 'कॉल उठाएँ',
  drillDecline: 'अभी नहीं',
  drillConnecting: 'कॉल जोड़ रहे हैं…',
  drillHeadphones: 'हो सके तो हेडफ़ोन लगाइए।',
  drillInCall: 'अभ्यास कॉल चल रही है',
  drillTimeLeft: 'बचा समय',
  drillEnd: 'कॉल काटें',
  drillSafeWordHint: 'कभी भी "{word}" बोलिए, कॉल तुरंत रुक जाएगी।',
  drillYouSaid: 'आपने कहा',
  drillEndedTitle: 'अभ्यास कॉल पूरी हुई',
  drillEndedBody: 'आपका नतीजा जल्द ही इसी पन्ने पर दिखेगा।',
  drillEndedHangup: 'आपने फ़ोन रख दिया। असली ठगी में भी यही सही कदम है।',
  drillEndedStopped: 'आपने कॉल रोक दी। बिलकुल ठीक किया।',
  drillEndedDeclined: 'कोई बात नहीं। अभ्यास कॉल बाद में फिर आ सकती है।',
  drillBackHome: 'मुख्य पन्ने पर जाएँ',
  drillRetry: 'दोबारा कोशिश करें',
  drillNone: 'अभी कोई अभ्यास कॉल नहीं है।',

  // The debrief. Never the words fail, mistake, careless or foolish, in either language —
  // `debrief.writer.v1` forbids them to the model and the rule applies to the screen too.
  debriefTitle: 'आपकी अभ्यास कॉल का नतीजा',
  debriefOpen: 'नतीजा देखें',
  debriefWaiting: 'तुम्हारा नतीजा तैयार हो रहा है…',
  debriefWaitingHint: 'एक मिनट से भी कम लगेगा। यह पन्ना अपने-आप खुल जाएगा।',
  debriefSlow: 'नतीजा तैयार होने में कुछ ज़्यादा समय लग रहा है।',
  debriefRetry: 'फिर से देखें',
  debriefListen: 'सुनिए',
  debriefPause: 'रोकिए',
  debriefAudioMissing: 'इस बार आवाज़ तैयार नहीं हो पाई। पूरी बात नीचे लिखी है।',
  debriefTurningPointLabel: 'कॉल का वह पल',
  debriefTurningPointHint: 'यही वह पल था जब फ़ोन रख देना चाहिए था।',
  debriefWentWellLabel: 'यह अच्छा रहा',
  debriefWentWellDefault: 'आपने अभ्यास करने की हिम्मत दिखाई। यही सबसे बड़ा बचाव है।',
  debriefWentWellHangUp: 'आपने कॉल जल्दी काट दी।',
  debriefWentWellVerify: 'आपने खुद जाँच करने की बात कही।',
  debriefWentWellHelpline: 'आपने हेल्पलाइन का नाम लिया।',
  debriefNoticedLabel: 'ठग ने क्या-क्या आज़माया',
  debriefFlagStayedOnCall: 'आप कॉल पर बने रहे।',
  debriefFlagAcceptedSecrecy: 'आपने बात किसी को न बताने की बात मान ली।',
  debriefFlagSharedIdentifier: 'आपने अपनी पहचान का नंबर बता दिया।',
  debriefFlagAgreedToMoveMoney: 'आपने पैसे भेजने की बात मान ली।',
  debriefFlagAcceptedAuthority: 'आपने मान लिया कि वह सरकारी अधिकारी है।',
  debriefFlagOther: 'ठग ने यह तरीका आज़माया।',
  debriefRulesTitle: 'हमेशा ये तीन बातें याद रखिए',
  debriefRuleHangUp: 'फ़ोन रख दीजिए। असली अधिकारी आपको फ़ोन रखने से कभी नहीं रोकते।',
  debriefRuleCall1930: '1930 पर कॉल कीजिए, या cybercrime.gov.in पर शिकायत दर्ज कीजिए।',
  debriefRuleNeverPay: 'कोई भी "जाँच" या "verification" के नाम पर पैसे भेजने को कहे, तो वह ठगी है।',
  debriefGeneric: 'इस बार हम पूरी कॉल नहीं पढ़ पाए, इसलिए कोई नतीजा नहीं दिखा रहे। आपने अभ्यास किया, यही मायने रखता है।',
  debriefBandSafe: 'आप पूरी तरह सतर्क रहे',
  debriefBandWobbly: 'आप कुछ देर बातचीत में बने रहे',
  debriefBandAtRisk: 'इस बार ठग आपको काफ़ी आगे तक ले गया',
  debriefNone: 'इस अभ्यास कॉल का कोई नतीजा नहीं है।',
  homeLastResult: 'पिछली अभ्यास कॉल',

  drillErrorMic: 'माइक्रोफ़ोन नहीं चल पाया, इसलिए कॉल नहीं हो सकी।',
  drillErrorAudio: 'इस फ़ोन पर आवाज़ नहीं चल पाई।',
  drillErrorConnection: 'कॉल कट गई। कोई बात नहीं, दोबारा कोशिश कर सकते हैं।',
  drillErrorNotReady: 'यह अभ्यास कॉल अब उपलब्ध नहीं है।',
  drillErrorOutsideWindow: 'अभी आपका चुना हुआ समय नहीं है।',
  drillErrorWeeklyCap: 'इस हफ़्ते की अभ्यास कॉल हो चुकी है।',
  drillErrorNotConsented: 'अभ्यास कॉल अभी बंद हैं।',

  errorGeneric: 'कुछ गड़बड़ हुई। कृपया फिर से कोशिश कीजिए।',
};

type Dict = typeof hi;
export type MessageKey = keyof Dict;

const en: Dict = {
  appName: 'Chaukanna',
  switchLanguage: 'हिंदी',
  practiceBadge: 'This is only practice',

  consentTitle: 'Practice spotting scams',
  consentGreeting: 'Hello {name}.',
  consentIntro: 'Your family would like to set up practice calls for you. Nothing happens without your yes.',
  consentPointCalls: 'Now and then you will get a practice call that talks like a scammer. It will never be real.',
  consentPointAudio: 'The audio of a practice call is deleted automatically after 7 days.',
  consentPointFamily: 'Your family sees only the result, not what you said.',
  consentPointStop: 'You can stop all practice calls at any time.',
  consentSayThis: 'Press the button below and say this sentence:',
  consentSentence: 'Yes, I am ready for practice calls.',
  consentPrimary: 'Yes, I am ready',
  consentMicAsk: 'Please allow the microphone in the question that just appeared.',
  consentRecording: 'Speak now… {seconds}',
  consentSaving: 'Saving…',
  consentMicDenied: 'The microphone did not work. That is fine, type "yes" below to confirm.',
  consentTypedLabel: 'Type "yes" here',
  consentTypedConfirm: 'Confirm',
  consentTypedInvalid: 'Please type "yes".',
  consentDone: 'Thank you. Your yes has been saved.',

  inviteInvalidTitle: 'This link no longer works',
  inviteInvalidBody: 'Please ask your family for a new link.',

  stopAll: 'Stop all practice calls',
  stopAllConfirm: 'All practice calls have been stopped.',
  stopping: 'Stopping…',

  windowTitle: 'When can practice calls come?',
  windowHelp: 'At any time inside these hours, at most once a week.',
  windowDays: 'Days',
  windowFrom: 'From',
  windowTo: 'Until',
  windowSave: 'Save',
  windowSaved: 'Your times are saved.',
  windowInvalid: 'Pick at least one day, and keep the time at least one hour long.',
  windowSummary: '{days}, {start} to {end}',
  day1: 'Mon',
  day2: 'Tue',
  day3: 'Wed',
  day4: 'Thu',
  day5: 'Fri',
  day6: 'Sat',
  day7: 'Sun',

  homeGreeting: 'Hello {name}',
  statusActive: 'Practice calls are on',
  statusPaused: 'Practice calls are stopped',
  statusRevoked: 'You have taken back your yes',
  statusInvited: 'We are still waiting for your yes',
  homeWindowLabel: 'Practice call hours',
  homeChangeWindow: 'Change hours',
  homeResume: 'Turn practice calls back on',
  homeWithdraw: 'Take back my yes',
  homeWithdrawDone: 'Your yes has been taken back.',
  homeNoSession: 'Please open this page from the link your family sent you.',
  homeCallWaiting: 'A practice call is waiting for you',
  homeSharingLabel: 'Let my family read what I said during practice',
  homeSharingHelp: 'Right now only you can read it. You can change this whenever you want.',
  homeSharingOn: 'Your family can read what you said',
  homeSharingOff: 'What you said stays with you',
  homeSharingAllow: 'Let my family read it',
  homeSharingStop: 'Stop letting them read it',
  homeOpenCall: 'Open the practice call',

  drillRingingTitle: 'Practice call',
  drillRingingCaller: 'Unknown number',
  drillAnswer: 'Answer',
  drillDecline: 'Not now',
  drillConnecting: 'Connecting the call…',
  drillHeadphones: 'Use headphones if you can.',
  drillInCall: 'Practice call in progress',
  drillTimeLeft: 'Time left',
  drillEnd: 'End call',
  drillSafeWordHint: 'Say "{word}" at any time and the call stops at once.',
  drillYouSaid: 'You said',
  drillEndedTitle: 'Practice call finished',
  drillEndedBody: 'Your result will appear on this page shortly.',
  drillEndedHangup: 'You put the phone down. In a real scam that is exactly right.',
  drillEndedStopped: 'You stopped the call. That was the right thing to do.',
  drillEndedDeclined: 'That is fine. A practice call can come again later.',
  drillBackHome: 'Back to my page',
  drillRetry: 'Try again',
  drillNone: 'There is no practice call waiting.',

  debriefTitle: 'How your practice call went',
  debriefOpen: 'See the result',
  debriefWaiting: 'Your result is being prepared…',
  debriefWaitingHint: 'This takes less than a minute. The page will open by itself.',
  debriefSlow: 'The result is taking a little longer than usual.',
  debriefRetry: 'Look again',
  debriefListen: 'Listen',
  debriefPause: 'Pause',
  debriefAudioMissing: 'The spoken version is not ready this time. Everything is written below.',
  debriefTurningPointLabel: 'The moment in the call',
  debriefTurningPointHint: 'That was the moment to put the phone down.',
  debriefWentWellLabel: 'This went well',
  debriefWentWellDefault: 'You were willing to practise. That is the strongest protection there is.',
  debriefWentWellHangUp: 'You ended the call early.',
  debriefWentWellVerify: 'You said you would check for yourself.',
  debriefWentWellHelpline: 'You named the helpline.',
  debriefNoticedLabel: 'What the caller tried',
  debriefFlagStayedOnCall: 'You stayed on the call.',
  debriefFlagAcceptedSecrecy: 'You agreed to keep the call to yourself.',
  debriefFlagSharedIdentifier: 'You gave out an identifying number.',
  debriefFlagAgreedToMoveMoney: 'You agreed to move money.',
  debriefFlagAcceptedAuthority: 'You accepted that the caller was a government official.',
  debriefFlagOther: 'The caller tried this on you.',
  debriefRulesTitle: 'Always remember these three things',
  debriefRuleHangUp: 'Put the phone down. Real officials never stop you from hanging up.',
  debriefRuleCall1930: 'Call 1930, or report it at cybercrime.gov.in.',
  debriefRuleNeverPay: 'If anyone asks you to send money for a "check" or "verification", it is a scam.',
  debriefGeneric: 'We could not read the whole call this time, so we are not showing a result. You practised, and that is what counts.',
  debriefBandSafe: 'You stayed alert throughout',
  debriefBandWobbly: 'You stayed in the conversation for a while',
  debriefBandAtRisk: 'This time the caller led you quite far',
  debriefNone: 'There is no result for this practice call.',
  homeLastResult: 'Your last practice call',

  drillErrorMic: 'The microphone did not work, so the call could not start.',
  drillErrorAudio: 'Sound did not work on this phone.',
  drillErrorConnection: 'The call was cut off. That is fine, you can try again.',
  drillErrorNotReady: 'This practice call is no longer available.',
  drillErrorOutsideWindow: 'This is not one of the hours you chose.',
  drillErrorWeeklyCap: 'This week’s practice call has already happened.',
  drillErrorNotConsented: 'Practice calls are stopped at the moment.',

  errorGeneric: 'Something went wrong. Please try again.',
};

const dictionaries: Record<Lang, Dict> = { hi, en };

export function t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[lang][key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function langFromLocale(locale: 'hi-IN' | 'en-IN'): Lang {
  return locale === 'en-IN' ? 'en' : 'hi';
}

export function localeFromLang(lang: Lang): 'hi-IN' | 'en-IN' {
  return lang === 'en' ? 'en-IN' : 'hi-IN';
}

/**
 * The three rules every debrief closes with, in the order `debrief.writer.v1` fixes them
 * (PRD F6 AC3). Keys rather than sentences, so that the order is stated once and the wording
 * lives in both dictionaries.
 *
 * They live here, next to the words, rather than in `lib/debrief.ts`, for a second reason: the
 * debrief screen is a client component, and `lib/debrief.ts` reaches DynamoDB and S3. Importing
 * the order from there dragged the whole AWS SDK into the browser bundle.
 *
 * Reordering this array changes what a frightened person is told to do first. Do not.
 */
export const DEBRIEF_RULE_KEYS = ['debriefRuleHangUp', 'debriefRuleCall1930', 'debriefRuleNeverPay'] as const;
export type DebriefRuleKey = (typeof DEBRIEF_RULE_KEYS)[number];

/** Words accepted by the typed consent fallback, compared after trimming and lower casing. */
export const TYPED_YES = new Set(['हाँ', 'हां', 'haan', 'haa', 'han', 'ha', 'yes']);

export function windowSummary(lang: Lang, days: number[], start: string, end: string): string {
  const dayKeys = [...days].sort((a, b) => a - b).map((d) => t(lang, `day${d}` as MessageKey));
  return t(lang, 'windowSummary', { days: dayKeys.join(', '), start, end });
}
