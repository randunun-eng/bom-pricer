FX_RATES = {
    "LKR": 1 / 320.0,   # example: 1 USD ≈ 320 LKR
    "USD": 1.0
}

def to_usd(value, currency):
    rate = FX_RATES.get(currency)
    if rate is None:
        return None
    return round(value * rate, 4)
