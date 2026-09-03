# Telegram Video Downloader — Repo តែមួយ

កាលមុន project នេះមាន **repo ពីរ**៖
- `frontend/` — គេហទំព័រ (React) សម្រាប់មើល UI
- `backend/` — server Node.js ដែលភ្ជាប់ទៅគណនី Telegram របស់អ្នក (userbot) ហើយទាញយកវីដេអូ

**មូលហេតុដែលវាញែកគ្នា** មិនមែនកំហុសទេ៖ `backend` ត្រូវការនៅដំណើរការជានិច្ច (long-running
process) ព្រោះវារក្សាទុកការតភ្ជាប់ទៅ Telegram ដោយផ្ទាល់ ចំណែក `frontend` វិញគ្រាន់តែជា
ឯកសារ static (HTML/JS/CSS) ដែលអាចដាក់លើ hosting ណាមួយក៏បាន។ ដូច្នេះពួកគេត្រូវការវិធី
deploy ខុសគ្នា — នេះហើយជាមូលហេតុដែលមានអារម្មណ៍ថា "ពិបាកភ្ជាប់គ្នា"។

ដើម្បីធ្វើឲ្យវាស្រួល ខ្ញុំបានដាក់ទាំងពីរចូល **repo តែមួយ**នេះ ហើយកែ `backend` ឲ្យអាច
**បម្រើ (serve) frontend ដែល build រួចផងដែរ** — មានន័យថា អ្នកអាចដំណើរការវាជា
**process តែមួយ, port តែមួយ** បាន (មិនចាំបាច់កំណត់ backend URL ដាច់ដោយឡែកទៀតទេ)។

---

## វិធីទី 1 (ស្រួលបំផុត — recommended): ដំណើរការជា server តែមួយ

ល្អសម្រាប់ដាក់លើ VPS/Railway/Render តែមួយ ឬសាកល្បងក្នុងម៉ាស៊ីនផ្ទាល់ខ្លួន។

```bash
git clone <your-repo-url>
cd telegram-video-downloader
npm run install:all      # install ទាំង backend និង frontend

cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# បំពេញ .env ទាំងពីរ (មើលផ្នែក "Environment variables" ខាងក្រោម)

npm run build             # build frontend ហើយចម្លងចូល backend/public
npm start                 # ដំណើរការ backend — វានឹង serve UI ផងដែរ
```

បើកមើលនៅ `http://localhost:8787` — នេះជា URL តែមួយសម្រាប់ទាំង UI និង API។
ដោយសារវាដំណើរការ origin តែមួយ អ្នក**មិនចាំបាច់**កំណត់
`VITE_TELEGRAM_BACKEND_URL` ក្នុង `frontend/.env` ទេ (ទុកឲ្យទទេបាន)។

## វិធីទី 2: ដំណើរការដាច់ពីគ្នា (dev mode, ឬដាក់ hosting ដាច់ពីគ្នាដូចមុន)

ល្អសម្រាប់ពេលអភិវឌ្ឍន៍ (មាន hot-reload) ឬបើអ្នកចង់ដាក់ frontend លើ Bolt/Vercel/Netlify
ដាច់ពី backend លើ Railway/Render ដូចមុន។

```bash
npm run install:all
npm run dev
```

វានេះនឹងបើក backend នៅ `http://localhost:8787` និង frontend (dev server, មាន
hot-reload) នៅ `http://localhost:5173` ក្នុងពេលតែមួយ។ ក្នុងករណីនេះ
`frontend/.env` ត្រូវកំណត់ `VITE_TELEGRAM_BACKEND_URL=http://localhost:8787`។

---

## Environment variables

### `backend/.env`
| ឈ្មោះ | អត្ថន័យ |
|---|---|
| `SUPABASE_URL` | URL គម្រោង Supabase (ដូចគ្នានឹង frontend) |
| `SUPABASE_SERVICE_KEY` | **service_role** key (Project Settings → API) — មិនមែន `anon` key ទេ |
| `ALLOWED_ORIGINS` | localhost:5173 សម្រាប់ dev; ទុកទទេ/មិនចាំបាច់ប្រសិនបើ serve ជាមួយ frontend port តែមួយ |
| `BACKEND_API_KEY` | ពាក្យសម្ងាត់ណាមួយវែងៗ ដែលអ្នកបង្កើតដោយខ្លួនឯង |
| `PORT` | port សម្រាប់ server (default 8787) |

### `frontend/.env`
| ឈ្មោះ | អត្ថន័យ |
|---|---|
| `VITE_SUPABASE_URL` | URL គម្រោង Supabase |
| `VITE_SUPABASE_ANON_KEY` | **anon** key (មិនមែន service_role) |
| `VITE_TELEGRAM_BACKEND_URL` | ទុកទទេប្រសិនបើប្រើវិធីទី 1 (server តែមួយ); កំណត់ URL backend ប្រសិនបើ deploy ដាច់ដោយឡែក |
| `VITE_TELEGRAM_BACKEND_KEY` | តម្លៃដូចគ្នានឹង `BACKEND_API_KEY` ខាងលើ |

Supabase migration តែមួយដែលត្រូវរត់ម្តង (SQL editor)៖
```sql
alter table groups add constraint groups_chat_id_key unique (chat_id);
```

---

## ចំណាំសុវត្ថិភាព

`session_string` ដែល backend រក្សាទុកក្នុង `telegram_settings` ផ្តល់សិទ្ធិពេញលេញលើ
គណនី Telegram របស់អ្នក។ កុំបញ្ចេញ `SUPABASE_SERVICE_KEY` និង `BACKEND_API_KEY` ជាសាធារណៈ
ឲ្យសោះ ហើយប្រើ Telegram userbot ដោយគោរពតាម Terms of Service របស់ Telegram
(ការទាញយក/scan ក្នុងបរិមាណច្រើនពេក អាចធ្វើឲ្យគណនីត្រូវ rate-limit ឬ ban)។
