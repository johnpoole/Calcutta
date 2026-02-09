import xlrd
wb = xlrd.open_workbook(r'c:\Users\jdpoo\Documents\GitHub\Calcutta\data\2026 Ladies (12) and Men (23) Club Champs.xls')

for sname in ["Men's Draw", "Ladies' Draw"]:
    sheet = wb.sheet_by_name(sname)
    print(f"\n=== {sname} - non-empty cells ===")
    for r in range(sheet.nrows):
        for c in range(sheet.ncols):
            v = sheet.cell_value(r, c)
            if isinstance(v, str) and v.strip():
                print(f"  [{r:>3},{c:>2}] {v.strip()}")
            elif isinstance(v, float) and v != 0:
                print(f"  [{r:>3},{c:>2}] {v}")
