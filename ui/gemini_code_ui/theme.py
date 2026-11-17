"""The app's look, modelled on Claude Code's desktop app. Colours live here and nowhere else."""
from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import QApplication

BG = "#262624"
SIDEBAR = "#1f1e1d"
SURFACE = "#30302e"
RAISED = "#3a3a37"
INSET = "#1a1918"
BORDER = "#464541"
TEXT = "#f5f4ef"
MUTED = "#a8a59d"
ACCENT = "#d97757"
ACCENT_HOVER = "#e08a6d"
ON_ACCENT = "#1f1e1d"
LINK = "#e8a68f"
GOOD = "#8fc98f"
WARN = "#e5b567"
BAD = "#ec8a7f"

UI_FONT = "Segoe UI"
MONO_FONT = "Cascadia Mono"
# Each system's own font, so the Mac app doesn't fall back to a generic one.
UI_STACK = f'"{UI_FONT}", "SF Pro Text", "Helvetica Neue", sans-serif'
MONO_STACK = f'"{MONO_FONT}", Consolas, Menlo, monospace'

STYLE = f"""
* {{ font-family: {UI_STACK}; font-size: 10pt; color: {TEXT}; }}
QMainWindow, QDialog, QWidget#page {{ background: {BG}; }}
QWidget#sidebar {{ background: {SIDEBAR}; border-right: 1px solid {SURFACE}; }}
QLabel {{ background: transparent; }}
QLabel#brand {{ font-size: 12pt; font-weight: 600; }}
QLabel#heading {{ font-size: 14pt; font-weight: 600; }}
QLabel#muted, QLabel#help {{ color: {MUTED}; }}
QLabel#help {{ font-size: 9pt; }}

QListWidget#nav {{ background: transparent; border: none; outline: none; }}
QListWidget#nav::item {{ padding: 6px 10px; border-radius: 8px; color: {MUTED}; }}
QListWidget#nav::item:hover {{ background: {SURFACE}; color: {TEXT}; }}
QListWidget#nav::item:selected {{ background: {RAISED}; color: {TEXT}; }}

QPushButton {{
    background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 8px; padding: 6px 12px;
}}
QPushButton:hover {{ background: {RAISED}; }}
QPushButton:pressed {{ background: {BORDER}; }}
QPushButton:disabled {{ color: {MUTED}; background: transparent; border-color: {SURFACE}; }}
QPushButton:focus {{ border-color: {MUTED}; }}
QPushButton#primary {{ background: {ACCENT}; color: {ON_ACCENT}; border-color: {ACCENT}; font-weight: 600; }}
QPushButton#primary:hover {{ background: {ACCENT_HOVER}; border-color: {ACCENT_HOVER}; }}
QPushButton#primary:disabled {{ background: {SURFACE}; color: {MUTED}; border-color: {SURFACE}; }}
QPushButton#danger {{ color: {BAD}; }}
QPushButton#small {{ padding: 2px 8px; font-size: 9pt; }}
QPushButton#chip {{ padding: 2px 8px; font-size: 9pt; border-radius: 10px; }}
QPushButton#ghost {{
    background: transparent; border: none; border-radius: 8px; padding: 6px 10px; text-align: left;
}}
QPushButton#ghost:hover, QPushButton#ghost:focus {{ background: {SURFACE}; }}
QPushButton#ghost:disabled {{ color: {MUTED}; background: transparent; }}
QPushButton#pill {{
    background: transparent; border: none; border-radius: 8px; padding: 4px 8px; color: {MUTED};
}}
QPushButton#pill:hover, QPushButton#pill:focus {{ background: {RAISED}; color: {TEXT}; }}
QPushButton#pill:disabled {{ color: {BORDER}; background: transparent; }}
QPushButton#pill::menu-indicator {{ image: none; width: 0; }}
QPushButton#pill:checked {{ color: {ACCENT}; background: {RAISED}; }}
QPushButton#icon {{
    background: transparent; border: 1px solid {BORDER}; border-radius: 15px; padding: 0;
    color: {MUTED}; font-size: 13pt;
}}
QPushButton#icon:hover, QPushButton#icon:focus {{ background: {RAISED}; color: {TEXT}; }}
QPushButton#icon:disabled {{ color: {BORDER}; }}
QPushButton#send, QPushButton#stop {{
    border: none; border-radius: 15px; padding: 0; font-size: 12pt; font-weight: 700;
}}
QPushButton#send {{ background: {ACCENT}; color: {ON_ACCENT}; }}
QPushButton#send:hover, QPushButton#send:focus {{ background: {ACCENT_HOVER}; }}
QPushButton#send:disabled {{ background: {RAISED}; color: {MUTED}; }}
QPushButton#stop {{ background: {TEXT}; color: {INSET}; font-size: 9pt; }}
QPushButton#stop:hover, QPushButton#stop:focus {{ background: {MUTED}; }}
QPushButton#chevron {{
    background: transparent; border: none; padding: 0; color: {MUTED}; font-size: 9pt;
}}
QPushButton#chevron:hover, QPushButton#chevron:focus {{ color: {TEXT}; }}
QPushButton#segment {{
    background: transparent; border: 1px solid {BORDER}; border-radius: 6px; padding: 3px 10px; color: {MUTED};
}}
QPushButton#segment:hover, QPushButton#segment:focus {{ color: {TEXT}; }}
QPushButton#segment:checked {{ background: {RAISED}; color: {TEXT}; border-color: {MUTED}; }}

QComboBox, QLineEdit, QSpinBox {{
    background: {INSET}; border: 1px solid {BORDER}; border-radius: 8px; padding: 5px 8px;
    selection-background-color: {ACCENT}; selection-color: {ON_ACCENT};
}}
QComboBox:focus, QLineEdit:focus, QSpinBox:focus {{ border-color: {MUTED}; }}
QComboBox:disabled, QLineEdit:disabled, QSpinBox:disabled {{ color: {MUTED}; }}
QComboBox::drop-down {{ border: none; width: 18px; }}
QComboBox QAbstractItemView {{
    background: {SURFACE}; border: 1px solid {BORDER}; outline: none;
    selection-background-color: {RAISED}; selection-color: {TEXT};
}}
QSpinBox::up-button, QSpinBox::down-button {{ width: 0; border: none; }}
QCheckBox::indicator {{
    width: 15px; height: 15px; border: 1px solid {MUTED}; border-radius: 4px; background: {INSET};
}}
QCheckBox::indicator:checked {{ background: {ACCENT}; border-color: {ACCENT}; }}
QCheckBox::indicator:focus {{ border-color: {TEXT}; }}

QGroupBox {{
    background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 10px; margin-top: 12px; padding: 10px;
    font-weight: 600;
}}
QGroupBox::title {{ subcontrol-origin: margin; left: 10px; padding: 0 4px; color: {MUTED}; }}
QGroupBox QLabel {{ font-weight: 400; }}

QMenu {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 10px; padding: 5px; }}
QMenu::item {{ padding: 6px 22px 6px 12px; border-radius: 6px; }}
QMenu::item:selected {{ background: {RAISED}; }}
QMenu::item:disabled {{ color: {MUTED}; }}
QMenu::separator {{ height: 1px; background: {BORDER}; margin: 5px 8px; }}

QScrollArea {{ background: transparent; border: none; }}
QScrollArea > QWidget > QWidget {{ background: transparent; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 2px; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 2px; }}
QScrollBar::handle {{ background: {BORDER}; border-radius: 3px; min-height: 24px; min-width: 24px; }}
QScrollBar::handle:hover {{ background: {MUTED}; }}
QScrollBar::add-line, QScrollBar::sub-line, QScrollBar::add-page, QScrollBar::sub-page {{
    background: none; border: none; width: 0; height: 0;
}}

QFrame#userBubble {{ background: {INSET}; border-radius: 12px; }}
QFrame#codeBlock {{ background: {INSET}; border: 1px solid {SURFACE}; border-radius: 8px; }}
QFrame#confirm {{ background: {SURFACE}; border: 1px solid {ACCENT}; border-radius: 12px; }}
QFrame#composerBox {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 16px; }}
QFrame#picker {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 12px; }}
QFrame#pickerRow {{ background: transparent; border-radius: 8px; }}
QFrame#pickerRow:hover, QFrame#pickerRow:focus {{ background: {RAISED}; }}
QFrame#pickerRow[locked="true"]:hover {{ background: transparent; }}
QFrame#pickerRule {{ background: {BORDER}; max-height: 1px; min-height: 1px; border: none; }}
QPlainTextEdit#composer {{ background: transparent; border: none; padding: 2px; }}
QPlainTextEdit#code, QPlainTextEdit#log {{
    background: transparent; border: none; font-family: {MONO_STACK}; font-size: 9pt;
}}
QPlainTextEdit#log {{ background: {INSET}; border: 1px solid {SURFACE}; border-radius: 8px; padding: 6px; }}
QTextBrowser {{ background: transparent; border: none; }}
QTextBrowser#document {{ background: {INSET}; border: 1px solid {SURFACE}; border-radius: 8px; padding: 10px; }}
QLabel#tool {{ font-family: {MONO_STACK}; font-size: 9pt; }}
QLabel#detail {{ font-family: {MONO_STACK}; font-size: 9pt; color: {MUTED}; }}
QLabel#detailBad {{ font-family: {MONO_STACK}; font-size: 9pt; color: {BAD}; }}
QLabel#note {{ color: {MUTED}; font-size: 9pt; }}
QLabel#noteWarn {{ color: {WARN}; font-size: 9pt; }}
QLabel#noteBad {{ color: {BAD}; font-size: 9pt; }}
QLabel#noteGood {{ color: {GOOD}; font-size: 9pt; }}
QLabel#locked {{ color: {ACCENT}; font-size: 9pt; }}
QToolTip {{ background: {SURFACE}; color: {TEXT}; border: 1px solid {BORDER}; }}
"""


def mono_font() -> QFont:
    font = QFont(MONO_FONT)
    font.setStyleHint(QFont.StyleHint.Monospace)
    font.setPointSize(9)
    return font


def apply_theme(app: QApplication) -> None:
    app.setStyle("Fusion")
    palette = app.palette()
    palette.setColor(QPalette.ColorRole.Window, QColor(BG))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(TEXT))
    palette.setColor(QPalette.ColorRole.Base, QColor(INSET))
    palette.setColor(QPalette.ColorRole.Text, QColor(TEXT))
    palette.setColor(QPalette.ColorRole.Button, QColor(SURFACE))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor(TEXT))
    palette.setColor(QPalette.ColorRole.Link, QColor(LINK))
    palette.setColor(QPalette.ColorRole.PlaceholderText, QColor(MUTED))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(ACCENT))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor(ON_ACCENT))
    app.setPalette(palette)
    app.setStyleSheet(STYLE)
