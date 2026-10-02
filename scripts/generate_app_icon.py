import math
from PIL import Image, ImageDraw, ImageFilter

def create_app_icon(size=512):
    # Create RGBA canvas
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Base Squircle (iOS / macOS modern squircle shape)
    padding = size * 0.06
    r = size * 0.22
    box = [padding, padding, size - padding, size - padding]

    # Create background layer with gradient
    bg_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg_layer)
    bg_draw.rounded_rectangle(box, radius=int(r), fill=(16, 20, 28, 255))

    # Gradient fill for squircle
    for y in range(int(padding), int(size - padding)):
        factor = (y - padding) / (size - 2 * padding)
        # Deep dark blue-gray to obsidian gradient
        r_c = int(22 + (10 - 22) * factor)
        g_c = int(28 + (13 - 28) * factor)
        b_c = int(38 + (18 - 38) * factor)
        for x in range(int(padding), int(size - padding)):
            # Check if point is inside rounded rect
            px, py = x, y
            dx = max(padding + r - px, 0, px - (size - padding - r))
            dy = max(padding + r - py, 0, py - (size - padding - r))
            if dx * dx + dy * dy <= r * r:
                bg_layer.putpixel((x, y), (r_c, g_c, b_c, 255))

    # Outer border glow (Amber gold top highlight)
    border_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    b_draw = ImageDraw.Draw(border_layer)
    b_draw.rounded_rectangle(box, radius=int(r), outline=(245, 166, 35, 180), width=int(size * 0.015))
    
    # 2. Glowing Amber Accent Aura
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    g_draw = ImageDraw.Draw(glow)
    center = (size * 0.5, size * 0.52)
    glow_r = size * 0.3
    g_draw.ellipse(
        [center[0] - glow_r, center[1] - glow_r, center[0] + glow_r, center[1] + glow_r],
        fill=(245, 166, 35, 45)
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=size * 0.1))

    # 3. Draw Isometric Layers (Order Automation Brand Symbol)
    symbol_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    s_draw = ImageDraw.Draw(symbol_layer)

    cx, cy = size * 0.5, size * 0.5
    w = size * 0.44
    h = size * 0.22

    # Layer 3 (Bottom Layer - Dark Teal / Steel)
    y3 = cy + size * 0.12
    p3_top = [cx, y3 - h * 0.5]
    p3_right = [cx + w * 0.5, y3]
    p3_bottom = [cx, y3 + h * 0.5]
    p3_left = [cx - w * 0.5, y3]
    s_draw.polygon([tuple(p3_top), tuple(p3_right), tuple(p3_bottom), tuple(p3_left)], fill=(35, 45, 60, 240), outline=(45, 212, 191, 180), width=int(size * 0.01))

    # Layer 2 (Middle Layer - Deep Amber)
    y2 = cy
    p2_top = [cx, y2 - h * 0.5]
    p2_right = [cx + w * 0.5, y2]
    p2_bottom = [cx, y2 + h * 0.5]
    p2_left = [cx - w * 0.5, y2]
    s_draw.polygon([tuple(p2_top), tuple(p2_right), tuple(p2_bottom), tuple(p2_left)], fill=(45, 35, 20, 240), outline=(245, 166, 35, 200), width=int(size * 0.012))

    # Layer 1 (Top Layer - Bright Golden Amber Plate)
    y1 = cy - size * 0.12
    p1_top = [cx, y1 - h * 0.5]
    p1_right = [cx + w * 0.5, y1]
    p1_bottom = [cx, y1 + h * 0.5]
    p1_left = [cx - w * 0.5, y1]
    s_draw.polygon([tuple(p1_top), tuple(p1_right), tuple(p1_bottom), tuple(p1_left)], fill=(245, 166, 35, 255), outline=(255, 210, 100, 255), width=int(size * 0.014))

    # Inner Top Plate Inset
    iw = w * 0.75
    ih = h * 0.75
    pi_top = [cx, y1 - ih * 0.5]
    pi_right = [cx + iw * 0.5, y1]
    pi_bottom = [cx, y1 + ih * 0.5]
    pi_left = [cx - iw * 0.5, y1]
    s_draw.polygon([tuple(pi_top), tuple(pi_right), tuple(pi_bottom), tuple(pi_left)], fill=(255, 185, 55, 255), outline=(255, 235, 160, 255), width=int(size * 0.008))

    # Center Check / Zap Symbol on Top Plate
    # Stylized clean checkmark on top plate
    chk = [
        (cx - size * 0.08, y1),
        (cx - size * 0.02, y1 + size * 0.04),
        (cx + size * 0.09, y1 - size * 0.05)
    ]
    s_draw.line(chk, fill=(26, 18, 5, 255), width=int(size * 0.035), joint="round")

    # Merge Layers
    result = Image.alpha_composite(img, bg_layer)
    result = Image.alpha_composite(result, glow)
    result = Image.alpha_composite(result, border_layer)
    result = Image.alpha_composite(result, symbol_layer)

    return result

if __name__ == "__main__":
    import os
    os.makedirs("resources", exist_ok=True)
    
    icon_512 = create_app_icon(512)
    icon_512.save("resources/icon.png", format="PNG")
    print("[OK] Saved resources/icon.png (512x512)")

    # Generate multi-resolution ICO (256, 128, 64, 48, 32, 16)
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    icon_512.save("resources/icon.ico", format="ICO", sizes=sizes)
    print("[OK] Saved resources/icon.ico with multi-resolutions")
