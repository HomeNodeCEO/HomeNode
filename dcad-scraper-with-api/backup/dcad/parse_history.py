from bs4 import BeautifulSoup
from .normalize import clean_text, to_num
def parse_value_history(soup):
    h = soup.find(lambda t: t.name in ('h2','h3','h4','b','strong') and 'market value' in t.get_text(strip=True).lower())
    if not h: return []
    tbl = h.find_next('table'); out = []
    for tr in tbl.find_all('tr')[1:]:
        tds = [clean_text(td.get_text()) for td in tr.find_all('td')]
        if len(tds) >= 4:
            year = int(to_num(tds[0]) or 0)
            out.append({"tax_year": year, "land_value": to_num(tds[1]),
                        "improvement_value": to_num(tds[2]), "market_value": to_num(tds[3]),
                        "taxable_value": to_num(tds[4]) if len(tds) > 4 else None})
    return out
def parse_owner_history(soup):
    h = soup.find(lambda t: t.name in ('h2','h3','h4','b','strong') and 'owner' in t.get_text(strip=True).lower())
    if not h: return []
    tbl = h.find_next('table'); out = []
    for tr in tbl.find_all('tr')[1:]:
        tds = [clean_text(td.get_text()) for td in tr.find_all('td')]
        if len(tds) >= 2:
            rec = {"observed_year": int(to_num(tds[0]) or 0), "owner_name": tds[1]}
            if len(tds) >= 6:
                rec.update({"mail_address": tds[2], "mail_city": tds[3], "mail_state": tds[4], "mail_zip": tds[5]})
            out.append(rec)
    return out
def parse_history_html(html: str):
    soup = BeautifulSoup(html, 'lxml')
    return {"value_history": parse_value_history(soup), "owner_history": parse_owner_history(soup)}
