// src/utils/timezone.js
//
// 2a/2b/2c support: browser-based player timezone/country detection,
// flag emoji + country name lookup, "their local time now" formatting,
// and the playing-window overlap calculation used for match-time
// suggestions. The TZ_TO_COUNTRY / COUNTRY_NAMES tables below are
// generated from the IANA tzdata distribution (zone1970.tab /
// iso3166.tab) — regenerate by re-running the same tzdata parse if this
// ever needs updating for a newer tzdata release.

// Auto-generated from IANA tzdata (zone1970.tab) — maps each IANA timezone
// identifier to its primary ISO 3166-1 alpha-2 country code.
export const TZ_TO_COUNTRY = {
  "Africa/Abidjan": "CI",
  "Africa/Algiers": "DZ",
  "Africa/Bissau": "GW",
  "Africa/Cairo": "EG",
  "Africa/Casablanca": "MA",
  "Africa/Ceuta": "ES",
  "Africa/El_Aaiun": "EH",
  "Africa/Johannesburg": "ZA",
  "Africa/Juba": "SS",
  "Africa/Maseru": "LS",
  "Africa/Mbabane": "SZ",
  "Africa/Khartoum": "SD",
  "Africa/Lagos": "NG",
  "Africa/Maputo": "MZ",
  "Africa/Monrovia": "LR",
  "Africa/Nairobi": "KE",
  "Africa/Ndjamena": "TD",
  "Africa/Sao_Tome": "ST",
  "Africa/Tripoli": "LY",
  "Africa/Tunis": "TN",
  "Africa/Windhoek": "NA",
  "America/Adak": "US",
  "America/Anchorage": "US",
  "America/Araguaina": "BR",
  "America/Argentina/Buenos_Aires": "AR",
  "America/Argentina/Catamarca": "AR",
  "America/Argentina/Cordoba": "AR",
  "America/Argentina/Jujuy": "AR",
  "America/Argentina/La_Rioja": "AR",
  "America/Argentina/Mendoza": "AR",
  "America/Argentina/Rio_Gallegos": "AR",
  "America/Argentina/Salta": "AR",
  "America/Argentina/San_Juan": "AR",
  "America/Argentina/San_Luis": "AR",
  "America/Argentina/Tucuman": "AR",
  "America/Argentina/Ushuaia": "AR",
  "America/Asuncion": "PY",
  "America/Bahia": "BR",
  "America/Bahia_Banderas": "MX",
  "America/Barbados": "BB",
  "America/Belem": "BR",
  "America/Belize": "BZ",
  "America/Boa_Vista": "BR",
  "America/Bogota": "CO",
  "America/Boise": "US",
  "America/Cambridge_Bay": "CA",
  "America/Campo_Grande": "BR",
  "America/Cancun": "MX",
  "America/Caracas": "VE",
  "America/Cayenne": "GF",
  "America/Chicago": "US",
  "America/Chihuahua": "MX",
  "America/Ciudad_Juarez": "MX",
  "America/Costa_Rica": "CR",
  "America/Coyhaique": "CL",
  "America/Cuiaba": "BR",
  "America/Danmarkshavn": "GL",
  "America/Dawson": "CA",
  "America/Dawson_Creek": "CA",
  "America/Denver": "US",
  "America/Detroit": "US",
  "America/Edmonton": "CA",
  "America/Eirunepe": "BR",
  "America/El_Salvador": "SV",
  "America/Fort_Nelson": "CA",
  "America/Fortaleza": "BR",
  "America/Glace_Bay": "CA",
  "America/Goose_Bay": "CA",
  "America/Grand_Turk": "TC",
  "America/Guatemala": "GT",
  "America/Guayaquil": "EC",
  "America/Guyana": "GY",
  "America/Halifax": "CA",
  "America/Havana": "CU",
  "America/Hermosillo": "MX",
  "America/Indiana/Indianapolis": "US",
  "America/Indiana/Knox": "US",
  "America/Indiana/Marengo": "US",
  "America/Indiana/Petersburg": "US",
  "America/Indiana/Tell_City": "US",
  "America/Indiana/Vevay": "US",
  "America/Indiana/Vincennes": "US",
  "America/Indiana/Winamac": "US",
  "America/Inuvik": "CA",
  "America/Iqaluit": "CA",
  "America/Jamaica": "JM",
  "America/Juneau": "US",
  "America/Kentucky/Louisville": "US",
  "America/Kentucky/Monticello": "US",
  "America/La_Paz": "BO",
  "America/Lima": "PE",
  "America/Los_Angeles": "US",
  "America/Maceio": "BR",
  "America/Managua": "NI",
  "America/Manaus": "BR",
  "America/Martinique": "MQ",
  "America/Matamoros": "MX",
  "America/Mazatlan": "MX",
  "America/Menominee": "US",
  "America/Merida": "MX",
  "America/Metlakatla": "US",
  "America/Mexico_City": "MX",
  "America/Miquelon": "PM",
  "America/Moncton": "CA",
  "America/Monterrey": "MX",
  "America/Montevideo": "UY",
  "America/New_York": "US",
  "America/Nome": "US",
  "America/Noronha": "BR",
  "America/North_Dakota/Beulah": "US",
  "America/North_Dakota/Center": "US",
  "America/North_Dakota/New_Salem": "US",
  "America/Nuuk": "GL",
  "America/Ojinaga": "MX",
  "America/Panama": "PA",
  "America/Paramaribo": "SR",
  "America/Phoenix": "US",
  "America/Port-au-Prince": "HT",
  "America/Porto_Velho": "BR",
  "America/Puerto_Rico": "PR",
  "America/Punta_Arenas": "CL",
  "America/Rankin_Inlet": "CA",
  "America/Recife": "BR",
  "America/Regina": "CA",
  "America/Resolute": "CA",
  "America/Rio_Branco": "BR",
  "America/Santarem": "BR",
  "America/Santiago": "CL",
  "America/Santo_Domingo": "DO",
  "America/Sao_Paulo": "BR",
  "America/Scoresbysund": "GL",
  "America/Sitka": "US",
  "America/St_Johns": "CA",
  "America/Swift_Current": "CA",
  "America/Tegucigalpa": "HN",
  "America/Thule": "GL",
  "America/Tijuana": "MX",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Whitehorse": "CA",
  "America/Winnipeg": "CA",
  "America/Yakutat": "US",
  "Antarctica/Casey": "AQ",
  "Antarctica/Davis": "AQ",
  "Antarctica/Macquarie": "AU",
  "Antarctica/Mawson": "AQ",
  "Antarctica/Palmer": "AQ",
  "Antarctica/Rothera": "AQ",
  "Antarctica/Troll": "AQ",
  "Antarctica/Vostok": "AQ",
  "Asia/Almaty": "KZ",
  "Asia/Amman": "JO",
  "Asia/Anadyr": "RU",
  "Asia/Aqtau": "KZ",
  "Asia/Aqtobe": "KZ",
  "Asia/Ashgabat": "TM",
  "Asia/Atyrau": "KZ",
  "Asia/Baghdad": "IQ",
  "Asia/Baku": "AZ",
  "Asia/Bangkok": "TH",
  "Asia/Barnaul": "RU",
  "Asia/Beirut": "LB",
  "Asia/Bishkek": "KG",
  "Asia/Chita": "RU",
  "Asia/Colombo": "LK",
  "Asia/Damascus": "SY",
  "Asia/Dhaka": "BD",
  "Asia/Dili": "TL",
  "Asia/Dubai": "AE",
  "Asia/Dushanbe": "TJ",
  "Asia/Famagusta": "CY",
  "Asia/Gaza": "PS",
  "Asia/Hebron": "PS",
  "Asia/Ho_Chi_Minh": "VN",
  "Asia/Hong_Kong": "HK",
  "Asia/Hovd": "MN",
  "Asia/Irkutsk": "RU",
  "Asia/Jakarta": "ID",
  "Asia/Jayapura": "ID",
  "Asia/Jerusalem": "IL",
  "Asia/Kabul": "AF",
  "Asia/Kamchatka": "RU",
  "Asia/Karachi": "PK",
  "Asia/Kathmandu": "NP",
  "Asia/Khandyga": "RU",
  "Asia/Kolkata": "IN",
  "Asia/Krasnoyarsk": "RU",
  "Asia/Kuching": "MY",
  "Asia/Macau": "MO",
  "Asia/Magadan": "RU",
  "Asia/Makassar": "ID",
  "Asia/Manila": "PH",
  "Asia/Nicosia": "CY",
  "Asia/Novokuznetsk": "RU",
  "Asia/Novosibirsk": "RU",
  "Asia/Omsk": "RU",
  "Asia/Oral": "KZ",
  "Asia/Pontianak": "ID",
  "Asia/Pyongyang": "KP",
  "Asia/Qatar": "QA",
  "Asia/Qostanay": "KZ",
  "Asia/Qyzylorda": "KZ",
  "Asia/Riyadh": "SA",
  "Asia/Sakhalin": "RU",
  "Asia/Samarkand": "UZ",
  "Asia/Seoul": "KR",
  "Asia/Shanghai": "CN",
  "Asia/Singapore": "SG",
  "Asia/Srednekolymsk": "RU",
  "Asia/Taipei": "TW",
  "Asia/Tashkent": "UZ",
  "Asia/Tbilisi": "GE",
  "Asia/Tehran": "IR",
  "Asia/Thimphu": "BT",
  "Asia/Tokyo": "JP",
  "Asia/Tomsk": "RU",
  "Asia/Ulaanbaatar": "MN",
  "Asia/Urumqi": "CN",
  "Asia/Ust-Nera": "RU",
  "Asia/Vladivostok": "RU",
  "Asia/Yakutsk": "RU",
  "Asia/Yangon": "MM",
  "Asia/Yekaterinburg": "RU",
  "Asia/Yerevan": "AM",
  "Atlantic/Azores": "PT",
  "Atlantic/Bermuda": "BM",
  "Atlantic/Canary": "ES",
  "Atlantic/Cape_Verde": "CV",
  "Atlantic/Faroe": "FO",
  "Atlantic/Madeira": "PT",
  "Atlantic/South_Georgia": "GS",
  "Atlantic/Stanley": "FK",
  "Australia/Adelaide": "AU",
  "Australia/Brisbane": "AU",
  "Australia/Broken_Hill": "AU",
  "Australia/Darwin": "AU",
  "Australia/Eucla": "AU",
  "Australia/Hobart": "AU",
  "Australia/Lindeman": "AU",
  "Australia/Lord_Howe": "AU",
  "Australia/Melbourne": "AU",
  "Australia/Perth": "AU",
  "Australia/Sydney": "AU",
  "Europe/Andorra": "AD",
  "Europe/Astrakhan": "RU",
  "Europe/Athens": "GR",
  "Europe/Belgrade": "RS",
  "Europe/Berlin": "DE",
  "Europe/Brussels": "BE",
  "Europe/Bucharest": "RO",
  "Europe/Budapest": "HU",
  "Europe/Chisinau": "MD",
  "Europe/Dublin": "IE",
  "Europe/Gibraltar": "GI",
  "Europe/Helsinki": "FI",
  "Europe/Istanbul": "TR",
  "Europe/Kaliningrad": "RU",
  "Europe/Kirov": "RU",
  "Europe/Kyiv": "UA",
  "Europe/Lisbon": "PT",
  "Europe/London": "GB",
  "Europe/Madrid": "ES",
  "Europe/Malta": "MT",
  "Europe/Minsk": "BY",
  "Europe/Moscow": "RU",
  "Europe/Paris": "FR",
  "Europe/Prague": "CZ",
  "Europe/Riga": "LV",
  "Europe/Rome": "IT",
  "Europe/Samara": "RU",
  "Europe/Saratov": "RU",
  "Europe/Simferopol": "RU",
  "Europe/Sofia": "BG",
  "Europe/Tallinn": "EE",
  "Europe/Tirane": "AL",
  "Europe/Ulyanovsk": "RU",
  "Europe/Vienna": "AT",
  "Europe/Vilnius": "LT",
  "Europe/Volgograd": "RU",
  "Europe/Warsaw": "PL",
  "Europe/Zurich": "CH",
  "Indian/Chagos": "IO",
  "Indian/Maldives": "MV",
  "Indian/Mauritius": "MU",
  "Pacific/Apia": "WS",
  "Pacific/Auckland": "NZ",
  "Pacific/Bougainville": "PG",
  "Pacific/Chatham": "NZ",
  "Pacific/Easter": "CL",
  "Pacific/Efate": "VU",
  "Pacific/Fakaofo": "TK",
  "Pacific/Fiji": "FJ",
  "Pacific/Galapagos": "EC",
  "Pacific/Gambier": "PF",
  "Pacific/Guadalcanal": "SB",
  "Pacific/Guam": "GU",
  "Pacific/Honolulu": "US",
  "Pacific/Kanton": "KI",
  "Pacific/Kiritimati": "KI",
  "Pacific/Kosrae": "FM",
  "Pacific/Kwajalein": "MH",
  "Pacific/Marquesas": "PF",
  "Pacific/Nauru": "NR",
  "Pacific/Niue": "NU",
  "Pacific/Norfolk": "NF",
  "Pacific/Noumea": "NC",
  "Pacific/Pago_Pago": "AS",
  "Pacific/Palau": "PW",
  "Pacific/Pitcairn": "PN",
  "Pacific/Port_Moresby": "PG",
  "Pacific/Rarotonga": "CK",
  "Pacific/Tahiti": "PF",
  "Pacific/Tarawa": "KI",
  "Pacific/Tongatapu": "TO",
};

// Auto-generated from IANA tzdata (iso3166.tab) — ISO 3166-1 alpha-2 code to
// short country/territory name.
export const COUNTRY_NAMES = {
  "AD": "Andorra",
  "AE": "United Arab Emirates",
  "AF": "Afghanistan",
  "AG": "Antigua & Barbuda",
  "AI": "Anguilla",
  "AL": "Albania",
  "AM": "Armenia",
  "AO": "Angola",
  "AQ": "Antarctica",
  "AR": "Argentina",
  "AS": "Samoa (American)",
  "AT": "Austria",
  "AU": "Australia",
  "AW": "Aruba",
  "AX": "Åland Islands",
  "AZ": "Azerbaijan",
  "BA": "Bosnia & Herzegovina",
  "BB": "Barbados",
  "BD": "Bangladesh",
  "BE": "Belgium",
  "BF": "Burkina Faso",
  "BG": "Bulgaria",
  "BH": "Bahrain",
  "BI": "Burundi",
  "BJ": "Benin",
  "BL": "St Barthelemy",
  "BM": "Bermuda",
  "BN": "Brunei",
  "BO": "Bolivia",
  "BQ": "Caribbean NL",
  "BR": "Brazil",
  "BS": "Bahamas",
  "BT": "Bhutan",
  "BV": "Bouvet Island",
  "BW": "Botswana",
  "BY": "Belarus",
  "BZ": "Belize",
  "CA": "Canada",
  "CC": "Cocos (Keeling) Islands",
  "CD": "Congo (Dem. Rep.)",
  "CF": "Central African Rep.",
  "CG": "Congo (Rep.)",
  "CH": "Switzerland",
  "CI": "Côte d’Ivoire",
  "CK": "Cook Islands",
  "CL": "Chile",
  "CM": "Cameroon",
  "CN": "China",
  "CO": "Colombia",
  "CR": "Costa Rica",
  "CU": "Cuba",
  "CV": "Cape Verde",
  "CW": "Curaçao",
  "CX": "Christmas Island",
  "CY": "Cyprus",
  "CZ": "Czech Republic",
  "DE": "Germany",
  "DJ": "Djibouti",
  "DK": "Denmark",
  "DM": "Dominica",
  "DO": "Dominican Republic",
  "DZ": "Algeria",
  "EC": "Ecuador",
  "EE": "Estonia",
  "EG": "Egypt",
  "EH": "Western Sahara",
  "ER": "Eritrea",
  "ES": "Spain",
  "ET": "Ethiopia",
  "FI": "Finland",
  "FJ": "Fiji",
  "FK": "Falkland Islands",
  "FM": "Micronesia",
  "FO": "Faroe Islands",
  "FR": "France",
  "GA": "Gabon",
  "GB": "Britain (UK)",
  "GD": "Grenada",
  "GE": "Georgia",
  "GF": "French Guiana",
  "GG": "Guernsey",
  "GH": "Ghana",
  "GI": "Gibraltar",
  "GL": "Greenland",
  "GM": "Gambia",
  "GN": "Guinea",
  "GP": "Guadeloupe",
  "GQ": "Equatorial Guinea",
  "GR": "Greece",
  "GS": "South Georgia & the South Sandwich Islands",
  "GT": "Guatemala",
  "GU": "Guam",
  "GW": "Guinea-Bissau",
  "GY": "Guyana",
  "HK": "Hong Kong",
  "HM": "Heard Island & McDonald Islands",
  "HN": "Honduras",
  "HR": "Croatia",
  "HT": "Haiti",
  "HU": "Hungary",
  "ID": "Indonesia",
  "IE": "Ireland",
  "IL": "Israel",
  "IM": "Isle of Man",
  "IN": "India",
  "IO": "British Indian Ocean Territory",
  "IQ": "Iraq",
  "IR": "Iran",
  "IS": "Iceland",
  "IT": "Italy",
  "JE": "Jersey",
  "JM": "Jamaica",
  "JO": "Jordan",
  "JP": "Japan",
  "KE": "Kenya",
  "KG": "Kyrgyzstan",
  "KH": "Cambodia",
  "KI": "Kiribati",
  "KM": "Comoros",
  "KN": "St Kitts & Nevis",
  "KP": "Korea (North)",
  "KR": "Korea (South)",
  "KW": "Kuwait",
  "KY": "Cayman Islands",
  "KZ": "Kazakhstan",
  "LA": "Laos",
  "LB": "Lebanon",
  "LC": "St Lucia",
  "LI": "Liechtenstein",
  "LK": "Sri Lanka",
  "LR": "Liberia",
  "LS": "Lesotho",
  "LT": "Lithuania",
  "LU": "Luxembourg",
  "LV": "Latvia",
  "LY": "Libya",
  "MA": "Morocco",
  "MC": "Monaco",
  "MD": "Moldova",
  "ME": "Montenegro",
  "MF": "St Martin (French)",
  "MG": "Madagascar",
  "MH": "Marshall Islands",
  "MK": "North Macedonia",
  "ML": "Mali",
  "MM": "Myanmar (Burma)",
  "MN": "Mongolia",
  "MO": "Macau",
  "MP": "Northern Mariana Islands",
  "MQ": "Martinique",
  "MR": "Mauritania",
  "MS": "Montserrat",
  "MT": "Malta",
  "MU": "Mauritius",
  "MV": "Maldives",
  "MW": "Malawi",
  "MX": "Mexico",
  "MY": "Malaysia",
  "MZ": "Mozambique",
  "NA": "Namibia",
  "NC": "New Caledonia",
  "NE": "Niger",
  "NF": "Norfolk Island",
  "NG": "Nigeria",
  "NI": "Nicaragua",
  "NL": "Netherlands",
  "NO": "Norway",
  "NP": "Nepal",
  "NR": "Nauru",
  "NU": "Niue",
  "NZ": "New Zealand",
  "OM": "Oman",
  "PA": "Panama",
  "PE": "Peru",
  "PF": "French Polynesia",
  "PG": "Papua New Guinea",
  "PH": "Philippines",
  "PK": "Pakistan",
  "PL": "Poland",
  "PM": "St Pierre & Miquelon",
  "PN": "Pitcairn",
  "PR": "Puerto Rico",
  "PS": "Palestine",
  "PT": "Portugal",
  "PW": "Palau",
  "PY": "Paraguay",
  "QA": "Qatar",
  "RE": "Réunion",
  "RO": "Romania",
  "RS": "Serbia",
  "RU": "Russia",
  "RW": "Rwanda",
  "SA": "Saudi Arabia",
  "SB": "Solomon Islands",
  "SC": "Seychelles",
  "SD": "Sudan",
  "SE": "Sweden",
  "SG": "Singapore",
  "SH": "St Helena",
  "SI": "Slovenia",
  "SJ": "Svalbard & Jan Mayen",
  "SK": "Slovakia",
  "SL": "Sierra Leone",
  "SM": "San Marino",
  "SN": "Senegal",
  "SO": "Somalia",
  "SR": "Suriname",
  "SS": "South Sudan",
  "ST": "Sao Tome & Principe",
  "SV": "El Salvador",
  "SX": "St Maarten (Dutch)",
  "SY": "Syria",
  "SZ": "Eswatini (Swaziland)",
  "TC": "Turks & Caicos Is",
  "TD": "Chad",
  "TF": "French S. Terr.",
  "TG": "Togo",
  "TH": "Thailand",
  "TJ": "Tajikistan",
  "TK": "Tokelau",
  "TL": "East Timor",
  "TM": "Turkmenistan",
  "TN": "Tunisia",
  "TO": "Tonga",
  "TR": "Turkey",
  "TT": "Trinidad & Tobago",
  "TV": "Tuvalu",
  "TW": "Taiwan",
  "TZ": "Tanzania",
  "UA": "Ukraine",
  "UG": "Uganda",
  "UM": "US minor outlying islands",
  "US": "United States",
  "UY": "Uruguay",
  "UZ": "Uzbekistan",
  "VA": "Vatican City",
  "VC": "St Vincent",
  "VE": "Venezuela",
  "VG": "Virgin Islands (UK)",
  "VI": "Virgin Islands (US)",
  "VN": "Vietnam",
  "VU": "Vanuatu",
  "WF": "Wallis & Futuna",
  "WS": "Samoa (western)",
  "YE": "Yemen",
  "YT": "Mayotte",
  "ZA": "South Africa",
  "ZM": "Zambia",
  "ZW": "Zimbabwe",
};// Best-effort ITU E.164 calling-code → primary ISO 3166-1 alpha-2 country map.
// Used ONLY as a fallback when browser timezone detection fails (see
// countryFromPhone in timezone.js) — several codes are shared by multiple
// countries (e.g. +1 covers the US, Canada, and NANP Caribbean states; +7
// covers Russia and Kazakhstan) and this map picks the most populous/likely
// one rather than resolving exact area codes. Sorted longest-prefix-first
// so a 3-digit code is matched before a shorter one that starts the same way.
export const CALLING_CODE_TO_COUNTRY = {
  // 1-digit
  "1": "US", "7": "RU",
  // 2-digit
  "20": "EG", "27": "ZA", "30": "GR", "31": "NL", "32": "BE", "33": "FR",
  "34": "ES", "36": "HU", "39": "IT", "40": "RO", "41": "CH", "43": "AT",
  "44": "GB", "45": "DK", "46": "SE", "47": "NO", "48": "PL", "49": "DE",
  "51": "PE", "52": "MX", "53": "CU", "54": "AR", "55": "BR", "56": "CL",
  "57": "CO", "58": "VE", "60": "MY", "61": "AU", "62": "ID", "63": "PH",
  "64": "NZ", "65": "SG", "66": "TH", "81": "JP", "82": "KR", "84": "VN",
  "86": "CN", "90": "TR", "91": "IN", "92": "PK", "93": "AF", "94": "LK",
  "95": "MM", "98": "IR",
  // 3-digit
  "211": "SS", "212": "MA", "213": "DZ", "216": "TN", "218": "LY",
  "220": "GM", "221": "SN", "222": "MR", "223": "ML", "224": "GN",
  "225": "CI", "226": "BF", "227": "NE", "228": "TG", "229": "BJ",
  "230": "MU", "231": "LR", "232": "SL", "233": "GH", "234": "NG",
  "235": "TD", "236": "CF", "237": "CM", "238": "CV", "239": "ST",
  "240": "GQ", "241": "GA", "242": "CG", "243": "CD", "244": "AO",
  "245": "GW", "246": "IO", "247": "AC", "248": "SC", "249": "SD",
  "250": "RW", "251": "ET", "252": "SO", "253": "DJ", "254": "KE",
  "255": "TZ", "256": "UG", "257": "BI", "258": "MZ", "260": "ZM",
  "261": "MG", "262": "RE", "263": "ZW", "264": "NA", "265": "MW",
  "266": "LS", "267": "BW", "268": "SZ", "269": "KM", "290": "SH",
  "291": "ER", "297": "AW", "298": "FO", "299": "GL",
  "350": "GI", "351": "PT", "352": "LU", "353": "IE", "354": "IS",
  "355": "AL", "356": "MT", "357": "CY", "358": "FI", "359": "BG",
  "370": "LT", "371": "LV", "372": "EE", "373": "MD", "374": "AM",
  "375": "BY", "376": "AD", "377": "MC", "378": "SM", "380": "UA",
  "381": "RS", "382": "ME", "383": "XK", "385": "HR", "386": "SI",
  "387": "BA", "389": "MK",
  "420": "CZ", "421": "SK", "423": "LI",
  "500": "FK", "501": "BZ", "502": "GT", "503": "SV", "504": "HN",
  "505": "NI", "506": "CR", "507": "PA", "508": "PM", "509": "HT",
  "590": "GP", "591": "BO", "592": "GY", "593": "EC", "594": "GF",
  "595": "PY", "596": "MQ", "597": "SR", "598": "UY", "599": "CW",
  "670": "TL", "672": "NF", "673": "BN", "674": "NR", "675": "PG",
  "676": "TO", "677": "SB", "678": "VU", "679": "FJ", "680": "PW",
  "681": "WF", "682": "CK", "683": "NU", "685": "WS", "686": "KI",
  "687": "NC", "688": "TV", "689": "PF", "690": "TK", "691": "FM",
  "692": "MH",
  "850": "KP", "852": "HK", "853": "MO", "855": "KH", "856": "LA",
  "870": "PN",
  "880": "BD", "886": "TW",
  "960": "MV", "961": "LB", "962": "JO", "963": "SY", "964": "IQ",
  "965": "KW", "966": "SA", "967": "YE", "968": "OM", "970": "PS",
  "971": "AE", "972": "IL", "973": "BH", "974": "QA", "975": "BT",
  "976": "MN", "977": "NP",
  "992": "TJ", "993": "TM", "994": "AZ", "995": "GE", "996": "KG",
  "998": "UZ",
};

// Try longest match first (3-digit, then 2-digit, then 1-digit) so e.g.
// "+233..." (Ghana) isn't mis-read as "+2" + something.
export const CALLING_CODE_LENGTHS = [3, 2, 1];

// Default "typical playing window" used for the overlap suggestion in
// 2c, per the roadmap: 5pm–10pm, confirmed as the clients' actual habit.
// Hours are in 24h local-time-of-day for whichever player the window
// belongs to. Kept as a single shared constant for now — there's no
// per-player customization UI yet, so both players use the same window.
export const DEFAULT_PLAY_WINDOW = { start: 17, end: 22 };

/**
 * Detects the browser/device's IANA timezone. This is the primary source
 * for 2a — accurate, live, no permission prompt, and correct even for
 * multi-timezone countries (unlike a country-code guess).
 * Returns null if the runtime doesn't support the Intl API (very old
 * browsers / non-browser environments).
 */
export function detectBrowserTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || null;
  } catch {
    return null;
  }
}

/**
 * Resolves an IANA timezone to its primary ISO 3166-1 alpha-2 country code,
 * via the generated TZ_TO_COUNTRY table. Some timezones span multiple
 * countries (rare post-1970) — this returns the first/primary one listed
 * for that zone, which is what tzdata itself considers canonical.
 */
export function countryFromTimezone(timeZone) {
  if (!timeZone) return null;
  return TZ_TO_COUNTRY[timeZone] || null;
}

/**
 * Fallback country detection (2a) for when browser timezone detection
 * fails entirely — derives a country from the phone number's calling
 * code, since every profile already has a phone number with a leading
 * "+<calling code>" (required for the wa.me links elsewhere in the app).
 * Best-effort only: some calling codes are shared by several countries
 * (e.g. +1 → US/Canada/Caribbean); see calling_codes.js for details.
 */
export function countryFromPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/^\+/, "").replace(/\D/g, "");
  if (!digits) return null;
  for (const len of CALLING_CODE_LENGTHS) {
    const prefix = digits.slice(0, len);
    if (CALLING_CODE_TO_COUNTRY[prefix]) return CALLING_CODE_TO_COUNTRY[prefix];
  }
  return null;
}

/**
 * Full 2a resolution: browser timezone first (also gives us a country via
 * the tz table), falling back to the phone-derived country only if browser
 * detection isn't available. Call this once at signup/profile-completion
 * time and store the result on the profile.
 */
export function resolvePlayerLocation(phone) {
  const timezone = detectBrowserTimezone();
  if (timezone) {
    // Prefer the tz table, but fall back to the phone's calling code if this
    // particular IANA zone isn't in our table (e.g. an alias/edge-case zone
    // like "Africa/Mbabane" that our generated table doesn't list) — better
    // to get a country from the phone than none at all.
    const country_code = countryFromTimezone(timezone) || countryFromPhone(phone);
    return { timezone, country_code };
  }
  const country_code = countryFromPhone(phone);
  return { timezone: null, country_code };
}

/**
 * Converts an ISO 3166-1 alpha-2 country code into its flag emoji via
 * Unicode regional indicator symbols. Returns "" for anything that isn't
 * a clean 2-letter code (e.g. missing data).
 */
export function countryCodeToFlagEmoji(code) {
  if (!code || code.length !== 2) return "";
  const base = 0x1f1e6; // regional indicator symbol letter A
  const chars = [...code.toUpperCase()].map((c) => {
    const offset = c.charCodeAt(0) - 65; // 'A' = 65
    if (offset < 0 || offset > 25) return null;
    return base + offset;
  });
  if (chars.some((c) => c === null)) return "";
  return String.fromCodePoint(...chars);
}

export function countryName(code) {
  if (!code) return null;
  return COUNTRY_NAMES[code] || null;
}

/**
 * Current UTC offset (in minutes, local = UTC + offset) for a given IANA
 * timezone, evaluated for a specific instant. Computed by diffing how the
 * Intl API renders `date` in that timezone vs. its own UTC value, so this
 * is correct for the given date even across a DST transition.
 */
export function getTimezoneOffsetMinutes(timeZone, date = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = dtf.formatToParts(date).reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
    const asUTC = Date.UTC(
      +parts.year, +parts.month - 1, +parts.day,
      +parts.hour, +parts.minute, +parts.second
    );
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch {
    return null;
  }
}

/**
 * "Their local time right now" (2b) — formats the current time in the
 * given IANA timezone, e.g. "9:42 PM". Returns null if the timezone is
 * missing/invalid so callers can just skip rendering it.
 */
export function formatLocalTimeNow(timeZone, date = new Date()) {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", minute: "2-digit",
    }).format(date);
  } catch {
    return null;
  }
}

function mod24(hours) {
  return ((hours % 24) + 24) % 24;
}

function formatHourLabel(hours) {
  const h = mod24(hours);
  const wholeHour = Math.floor(h);
  const minutes = Math.round((h - wholeHour) * 60);
  const period = wholeHour >= 12 ? "PM" : "AM";
  let displayHour = wholeHour % 12;
  if (displayHour === 0) displayHour = 12;
  return minutes === 0
    ? `${displayHour} ${period}`
    : `${displayHour}:${String(minutes).padStart(2, "0")} ${period}`;
}

function rangeOverlapMinutes(aStart, aEnd, bStart, bEnd) {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
}

/**
 * 2c — the actual "suggested best time to play" calculation. Converts
 * both players' typical playing windows into a common (UTC) timeline
 * using each timezone's current offset, then finds where they overlap.
 *
 * Windows are checked against the previous/same/next calendar day (a
 * ±14h timezone spread can otherwise miss a real overlap that only lines
 * up one day off) and the best (largest) overlap among those three is
 * used. If no overlap exists in any of them, returns hasOverlap: false
 * with the gap size so the UI can "say so honestly" per the roadmap,
 * instead of forcing a fake suggestion.
 */
export function suggestPlayTime(myTimeZone, theirTimeZone, myWindow = DEFAULT_PLAY_WINDOW, theirWindow = DEFAULT_PLAY_WINDOW, date = new Date()) {
  const myOffset = getTimezoneOffsetMinutes(myTimeZone, date);
  const theirOffset = getTimezoneOffsetMinutes(theirTimeZone, date);
  if (myOffset == null || theirOffset == null) return null;

  const myUtcStart = myWindow.start * 60 - myOffset;
  const myUtcEnd = myWindow.end * 60 - myOffset;

  let best = null;
  for (const shiftDays of [-1, 0, 1]) {
    const shift = shiftDays * 1440;
    const theirUtcStart = theirWindow.start * 60 - theirOffset + shift;
    const theirUtcEnd = theirWindow.end * 60 - theirOffset + shift;
    const overlap = rangeOverlapMinutes(myUtcStart, myUtcEnd, theirUtcStart, theirUtcEnd);
    if (!best || overlap > best.overlap) {
      best = { overlap, theirUtcStart, theirUtcEnd };
    }
  }

  if (best.overlap <= 0) {
    return { hasOverlap: false, gapHours: Math.round((-best.overlap) / 6) / 10 };
  }

  const overlapStart = Math.max(myUtcStart, best.theirUtcStart);
  const overlapEnd = Math.min(myUtcEnd, best.theirUtcEnd);

  const myRange = [(overlapStart + myOffset) / 60, (overlapEnd + myOffset) / 60];
  const theirRange = [(overlapStart + theirOffset) / 60, (overlapEnd + theirOffset) / 60];

  return {
    hasOverlap: true,
    myRangeLabel: `${formatHourLabel(myRange[0])} – ${formatHourLabel(myRange[1])}`,
    theirRangeLabel: `${formatHourLabel(theirRange[0])} – ${formatHourLabel(theirRange[1])}`,
  };
}
