import re
from decimal import Decimal
def clean_text(s): return re.sub(r'\s+', ' ', s or '').strip()
def to_bool(s): return clean_text(s).lower() in {'y','yes','true','1'}
def to_num(s):
    s = clean_text(s).replace(',', '').replace('%', '')
    if s.lower() in {'', 'n/a', 'na', '-', 'none'}: return None
    try: return Decimal(s)
    except: return None
def to_sqft(s):
    s = clean_text(s).lower().replace('sqft', '').replace('sf', ''); return to_num(s)
def pct_to_num(s): s = clean_text(s).replace('%', ''); return to_num(s)
