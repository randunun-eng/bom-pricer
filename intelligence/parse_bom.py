import re

def parse_bom_line(line: str):
    line = line.strip().upper()
    qty = 1

    m_qty = re.search(r'X\s*(\d+)', line)
    if m_qty:
        qty = int(m_qty.group(1))

    m_amp = re.search(r'(\d+)\s*A', line)
    current_A = int(m_amp.group(1)) if m_amp else None

    is_esc = "ESC" in line

    return {
        "canonical_type": "ESC" if is_esc else None,
        "current_A": current_A,
        "qty": qty,
        "raw": line
    }

def parse_bom(text: str):
    lines = text.strip().splitlines()
    return [parse_bom_line(l) for l in lines if l.strip()]

if __name__ == "__main__":
    bom = """
    30A ESC x2
    40A ESC x1
    """
    from pprint import pprint
    pprint(parse_bom(bom))
