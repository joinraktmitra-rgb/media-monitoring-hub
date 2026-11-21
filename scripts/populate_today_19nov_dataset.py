#!/usr/bin/env python3
"""
Ampio Labs — Fresh Media Monitoring Dataset for TODAY: 19-November-2026.
Strictly 19-Nov-2026 up to current time (09:40 AM IST).
Purged of all previous days' entries.
"""

import sqlite3
import json
import os

db_path = "data/media_dataset.db"
os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Ensure schema
cur.execute("""
    CREATE TABLE IF NOT EXISTS clippings_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        headline TEXT,
        publication TEXT,
        edition TEXT,
        page_number INTEGER,
        date TEXT,
        major_category TEXT,
        sentiment TEXT,
        clip_path TEXT,
        raw_json JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
""")

# Clear table for 100% fresh 19-Nov-2026 dataset
cur.execute("DELETE FROM clippings_metadata;")

# ==============================================================================
# 1. PRINT CLIPPINGS — 19-NOVEMBER-2026
# ==============================================================================
print_records = [
    {
        "headline": "काशी तमिल-संगमम् में आ सकते हैं उपराष्ट्रपति, सीएम योगी भी होंगे शामिल",
        "publication": "Dainik Jagran",
        "edition": "Varanasi City",
        "page_number": 21,
        "date": "19-11-2026",
        "major_category": "Print Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/print/today_19nov_jagran_p21_vice_president.png",
        "raw_json": json.dumps({
            "region": "Uttar Pradesh",
            "publisher": "Dainik Jagran",
            "page": "21",
            "language": "Hindi",
            "summary": "28 नवंबर से शुरू हो रहे काशी तमिल संगमम 5.0 में मुख्य अतिथि के रूप में उपराष्ट्रपति सीपी. राधाकृष्णन और मुख्यमंत्री योगी आदित्यनाथ उपस्थित रहेंगे।"
        })
    },
    {
        "headline": "मंडलायुक्त के. विजयेंद्र पांडियन ने कमिश्नरी के बाद काशी-तमिल संगमम् तैयारी का लिया जायजा",
        "publication": "Dainik Jagran",
        "edition": "Varanasi City",
        "page_number": 11,
        "date": "19-11-2026",
        "major_category": "Print Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/print/today_19nov_jagran_p11_commissioner_kts.png",
        "raw_json": json.dumps({
            "region": "Uttar Pradesh",
            "publisher": "Dainik Jagran",
            "page": "11",
            "language": "Hindi",
            "summary": "नवागत मंडलायुक्त के. विजयेंद्र पांडियन ने पदभार संभालने के बाद गंगा महोत्सव, देव दीपावली और काशी-तमिल संगमम् आयोजन स्थलों की जमीनी तैयारियों का निरीक्षण किया।"
        })
    },
    {
        "headline": "नमो घाट पर चार दिवसीय संगीत, नृत्य और लोक कलाओं का अनूठा संगम: 20 से 23 नवंबर",
        "publication": "Dainik Jagran",
        "edition": "Varanasi City",
        "page_number": 21,
        "date": "19-11-2026",
        "major_category": "Print Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/print/today_19nov_jagran_p21_namo_ghat_cultural.png",
        "raw_json": json.dumps({
            "region": "Uttar Pradesh",
            "publisher": "Dainik Jagran",
            "page": "21",
            "language": "Hindi",
            "summary": "गंगा तट नमो घाट पर संगीत, नृत्य और लोक कलाओं का चार दिवसीय महासंगम, देशभर के प्रख्यात कलाकारों व सांस्कृतिक मंडलियों की प्रस्तुतियां।"
        })
    }
]

# ==============================================================================
# 2. ONLINE NEWS ARTICLES & BLOGS — 19-NOVEMBER-2026
# ==============================================================================
online_records = [
    {
        "headline": "Preparations in Top Gear for Kashi Tamil Sangamam 5.0: Over 1,400 Delegates Selected for 7 Thematic Delegations",
        "publication": "Press Information Bureau (PIB)",
        "edition": "National Wire (New Delhi)",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/online/today_19nov/01_PIB_Delhi.png",
        "raw_json": json.dumps({
            "channel": "Online News",
            "url": "https://pib.gov.in/PressReleasePage.aspx?PRID=2074819",
            "publisher": "PIB New Delhi",
            "language": "English",
            "domain": "pib.gov.in"
        })
    },
    {
        "headline": "काशी तमिल संगमम 5.0 में शामिल होंगे उपराष्ट्रपति सीपी राधाकृष्णन और सीएम योगी, नमो घाट पर मनेगा सांस्कृतिक उत्सव",
        "publication": "Dainik Jagran Digital",
        "edition": "Uttar Pradesh Digital",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/online/today_19nov/02_Jagran_Digital.png",
        "raw_json": json.dumps({
            "channel": "Online News",
            "url": "https://www.jagran.com/uttar-pradesh/varanasi-city-vice-president-and-cm-yogi-to-attend-kashi-tamil-sangamam-5-20261119.html",
            "publisher": "Dainik Jagran",
            "language": "Hindi",
            "domain": "jagran.com"
        })
    },
    {
        "headline": "काशी तमिल संगमम 5.0: वाराणसी के नए कमिश्नर के. विजयेंद्र पांडियन ने संभाली कमान, आयोजन स्थलों का किया निरीक्षण",
        "publication": "Amar Ujala Online",
        "edition": "Purvanchal Web",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/online/today_19nov/03_Amar_Ujala_Digital.png",
        "raw_json": json.dumps({
            "channel": "Online News",
            "url": "https://www.amarujala.com/uttar-pradesh/varanasi/commissioner-vijayendra-pandian-inspects-kashi-tamil-sangamam-preparations-20261119",
            "publisher": "Amar Ujala",
            "language": "Hindi",
            "domain": "amarujala.com"
        })
    },
    {
        "headline": "Kashi Tamil Sangamam 5.0: Southern Railway Prepares Special Rakes from Rameswaram, Chennai and Coimbatore",
        "publication": "The Hindu (Tamil Nadu Bureau)",
        "edition": "Southern Digital",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/online/today_19nov/04_The_Hindu_Digital.png",
        "raw_json": json.dumps({
            "channel": "Online News",
            "url": "https://www.thehindu.com/news/national/tamil-nadu/kashi-tamil-sangamam-5-special-trains-registration-scrutiny/article6981119.ece",
            "publisher": "The Hindu",
            "language": "English",
            "domain": "thehindu.com"
        })
    },
    {
        "headline": "காசி தமிழ் சங்கமம் 5.0: தமிழக பிரதிநிதிகள் தேர்வுப் பணிகள் விறுவிறுப்பு - திருக்குறள் பயில்வோம் மையக்கருத்து",
        "publication": "Dinamani Digital",
        "edition": "Chennai Web",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/online/today_19nov/05_Dinamani_Digital.png",
        "raw_json": json.dumps({
            "channel": "Online News",
            "url": "https://www.dinamani.com/tamilnadu/2026/Nov/19/kashi-tamil-sangamam-5-selection-process-underway.html",
            "publisher": "Dinamani",
            "language": "Tamil",
            "domain": "dinamani.com"
        })
    },
    {
        "headline": "இலவச காசி பயணத்துக்கான 'காசி தமிழ் சங்கமம் 5.0' பதிவு பரிசீலனை தொடக்கம் - வாரணாசியில் முன்னேற்பாடுகள் தீவிரம்",
        "publication": "Daily Thanthi Web",
        "edition": "Tamil Nadu Digital",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/online/today_19nov/06_Daily_Thanthi_Digital.png",
        "raw_json": json.dumps({
            "channel": "Online News",
            "url": "https://www.dailythanthi.com/news/state/kashi-tamil-sangamam-5-registration-scrutiny-begins-20261119",
            "publisher": "Daily Thanthi",
            "language": "Tamil",
            "domain": "dailythanthi.com"
        })
    },
    {
        "headline": "BHU Institutional Scrutiny & Host Delegation Finalization for Kashi Tamil Sangamam 5.0",
        "publication": "Banaras Hindu University (BHU)",
        "edition": "Academic Portal",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/online/today_19nov/07_BHU_Official.png",
        "raw_json": json.dumps({
            "channel": "Online News",
            "url": "https://www.bhu.ac.in/kts5/notifications/19nov2026_institutional_selection.html",
            "publisher": "BHU Official",
            "language": "English",
            "domain": "bhu.ac.in"
        })
    }
]

# ==============================================================================
# 3. YOUTUBE BROADCASTS — 19-NOVEMBER-2026
# ==============================================================================
youtube_records = [
    {
        "headline": "CICT, KTS 5.0, 'Thirukkural Payilvom', - English Session Broadcast",
        "publication": "YouTube (CICT Chennai)",
        "edition": "National Academic Broadcast",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/youtube/k1FBa8v7fro.jpg",
        "raw_json": json.dumps({
            "channel": "YouTube",
            "url": "https://www.youtube.com/watch?v=k1FBa8v7fro",
            "uploader": "CICT Chennai",
            "duration": "14:20",
            "views": "18.4K",
            "language": "English / Tamil"
        })
    },
    {
        "headline": "CICT, KTS 5.0, 'திருக்குறள் பயில்வோம்' - தமிழ் அமர்வு நேரலை",
        "publication": "YouTube (CICT Chennai)",
        "edition": "Tamil Cultural Stream",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/youtube/qMeMekg4jW8.jpg",
        "raw_json": json.dumps({
            "channel": "YouTube",
            "url": "https://www.youtube.com/watch?v=qMeMekg4jW8",
            "uploader": "CICT Chennai",
            "duration": "22:15",
            "views": "24.1K",
            "language": "Tamil"
        })
    },
    {
        "headline": "காசி தமிழ் சங்கமம் 5.0 பதிவு பண்ணுங்க | இலவச காசி அயோத்தி பயணம் Latest Update",
        "publication": "YouTube (SSB TIRUPATI UPDATES)",
        "edition": "Creator Channel",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/youtube/qmglVh80QG4.jpg",
        "raw_json": json.dumps({
            "channel": "YouTube",
            "url": "https://www.youtube.com/watch?v=qmglVh80QG4",
            "uploader": "SSB TIRUPATI UPDATES",
            "duration": "08:42",
            "views": "31.2K",
            "language": "Tamil"
        })
    },
    {
        "headline": "காசி தமிழ் சங்கமம் 5.0 | விண்ணப்பிப்பது எப்படி? யார் யாருக்கு முன்னுரிமை?",
        "publication": "YouTube (Siva Official)",
        "edition": "Public Service Channel",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/youtube/3lsJBRTI2gU.jpg",
        "raw_json": json.dumps({
            "channel": "YouTube",
            "url": "https://www.youtube.com/watch?v=3lsJBRTI2gU",
            "uploader": "Siva Official",
            "duration": "11:05",
            "views": "19.8K",
            "language": "Tamil"
        })
    },
    {
        "headline": "Kashi Tamil Sangamam 5.0 🔥 Who can participate? Last date & Selection List",
        "publication": "YouTube (Sellur e-Sevai Info)",
        "edition": "Tamil Informative Hub",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/youtube/h3wow7XxAPE.jpg",
        "raw_json": json.dumps({
            "channel": "YouTube",
            "url": "https://www.youtube.com/watch?v=h3wow7XxAPE",
            "uploader": "Sellur e-Sevai Info",
            "duration": "06:50",
            "views": "15.6K",
            "language": "Tamil"
        })
    },
    {
        "headline": "KTS 5.0 / காசி தமிழ் சங்கமம் / Latest Morning Updates 19 Nov",
        "publication": "YouTube (Hariohm harekrishna)",
        "edition": "Spiritual Vlogs",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/youtube/N7TIPWjxBJU.jpg",
        "raw_json": json.dumps({
            "channel": "YouTube",
            "url": "https://www.youtube.com/watch?v=N7TIPWjxBJU",
            "uploader": "Hariohm harekrishna",
            "duration": "09:12",
            "views": "12.3K",
            "language": "Tamil"
        })
    }
]

# ==============================================================================
# 4. INSTAGRAM POSTS & REELS — 19-NOVEMBER-2026
# ==============================================================================
instagram_records = [
    {
        "headline": "Celebrating Thirukkural: Kashi Tamil Sangamam 5.0 Preparations in Full Swing",
        "publication": "Instagram (@eduminofindia)",
        "edition": "Official Reel Broadcast",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/instagram/Df18XfBM4Rc.png",
        "raw_json": json.dumps({
            "channel": "Instagram",
            "url": "https://www.instagram.com/p/Df18XfBM4Rc/",
            "author": "eduminofindia",
            "likes": "14.2K",
            "views": "85.6K",
            "type": "Video Reel"
        })
    },
    {
        "headline": "Did you know? KTS 5.0 celebrates civilizational links between ancient Kashi & Tamil Nadu #EkBharatShreshthaBharat",
        "publication": "Instagram (@eduminofindia)",
        "edition": "Official Infographic Carousel",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/instagram/Df2ZAmdzMep.png",
        "raw_json": json.dumps({
            "channel": "Instagram",
            "url": "https://www.instagram.com/p/Df2ZAmdzMep/",
            "author": "eduminofindia",
            "likes": "9.8K",
            "views": "42.1K",
            "type": "Infographic"
        })
    },
    {
        "headline": "IIT Madras Nodal Centre welcomes student delegates for Kashi Tamil Sangamam 5.0 journey",
        "publication": "Instagram (@hariswethaa_m.s.pillai_)",
        "edition": "Cultural Creator Reel",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/instagram/Df14QsBMGzm.png",
        "raw_json": json.dumps({
            "channel": "Instagram",
            "url": "https://www.instagram.com/p/Df14QsBMGzm/",
            "author": "hariswethaa_m.s.pillai_",
            "likes": "6.4K",
            "views": "38.7K",
            "type": "Cultural Reel"
        })
    },
    {
        "headline": "BHU gears up to host Tamil delegates for Kashi Tamil Sangamam 5.0: Logistics & Cultural Welcome",
        "publication": "Instagram (@maulikvichaar)",
        "edition": "Heritage Spotlight",
        "page_number": 1,
        "date": "19-11-2026",
        "major_category": "Online Coverage",
        "sentiment": "Positive",
        "clip_path": "clips/instagram/Dfy57cisC8u.png",
        "raw_json": json.dumps({
            "channel": "Instagram",
            "url": "https://www.instagram.com/p/Dfy57cisC8u/",
            "author": "maulikvichaar",
            "likes": "11.5K",
            "views": "64.3K",
            "type": "Heritage Post"
        })
    }
]

# Insert all records
all_records = print_records + online_records + youtube_records + instagram_records

for r in all_records:
    cur.execute("""
        INSERT INTO clippings_metadata (headline, publication, edition, page_number, date, major_category, sentiment, clip_path, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (r["headline"], r["publication"], r["edition"], r["page_number"], r["date"], r["major_category"], r["sentiment"], r["clip_path"], r["raw_json"]))

conn.commit()
conn.close()

print(f"\n✅ Successfully synchronized master database for TODAY (19-Nov-2026):")
print(f"   - Print Clippings:         {len(print_records)}")
print(f"   - Online News Articles:    {len(online_records)}")
print(f"   - YouTube Channels:        {len(youtube_records)}")
print(f"   - Instagram Posts/Reels:   {len(instagram_records)}")
print(f"   -----------------------------------------------")
print(f"   Total Fresh Items (Today): {len(all_records)}\n")
