use enigo::{
    Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings,
};
use rdev::{grab, Event, EventType, Key as RKey};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use tauri::{Emitter, State};

struct AppState {
    enigo: Mutex<Enigo>,
}

static IS_INTERCEPTING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct KeyPayload {
    r#type: String,
    key: String,
    #[serde(rename = "keyState")]
    key_state: String,
}

#[tauri::command]
fn start_intercept() {
    IS_INTERCEPTING.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn stop_intercept() {
    IS_INTERCEPTING.store(false, Ordering::SeqCst);
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn control_mouse(state: State<AppState>, action: String, x: f64, y: f64, button: Option<String>) {
    let mut enigo = match state.enigo.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    // main_display returns Result<(i32, i32), Error>
    let (width, height) = match enigo.main_display() {
        Ok(size) => size,
        Err(e) => {
             eprintln!("Failed to get display size: {:?}", e);
             return;
        }
    };

    if action == "scroll" {
        // 处理滚轮事件
        // 浏览器 deltaY > 0 为向下滚动，Enigo 对应正向滚动
        // 灵敏度调整：浏览器滚动通常以像素为单位 (如 100px)，Enigo 以“格”为单位
        let factor = 40.0; // 40px 对应 1 格，增加灵敏度
        let scroll_x = (x / factor) as i32;
        let scroll_y = (y / factor) as i32;

        if scroll_x != 0 {
            let _ = enigo.scroll(scroll_x, Axis::Horizontal);
        }
        if scroll_y != 0 {
            let _ = enigo.scroll(scroll_y, Axis::Vertical);
        }
        return;
    }

    // Convert normalized coordinates (0.0-1.0) to screen pixels
    let target_x = (x * width as f64) as i32;
    let target_y = (y * height as f64) as i32;

    // 强制先移动鼠标到目标位置
    // 这修复了以下问题：
    // 1. "移动"(UDP) 包丢失或延迟，导致 "点击"(TCP) 包到达时鼠标还未到达目标位置
    // 2. 确保点击操作总是发生在事件指定的精确坐标上，特别是对于最小化按钮等小目标
    let _ = enigo.move_mouse(target_x, target_y, Coordinate::Abs);

    match action.as_str() {
        "move" => {
            // 已在上方统一移动，此处无需额外操作
        }
        "down" => {
            let btn = match button.as_deref() {
                Some("right") => Button::Right,
                Some("middle") => Button::Middle,
                _ => Button::Left,
            };
            let _ = enigo.button(btn, Direction::Press);
        }
        "up" => {
            let btn = match button.as_deref() {
                Some("right") => Button::Right,
                Some("middle") => Button::Middle,
                _ => Button::Left,
            };
            let _ = enigo.button(btn, Direction::Release);
        }
        "click" => {
            let btn = match button.as_deref() {
                Some("right") => Button::Right,
                Some("middle") => Button::Middle,
                _ => Button::Left,
            };
            let _ = enigo.button(btn, Direction::Click);
        }
        _ => {}
    }
}

#[tauri::command]
fn control_keyboard(state: State<AppState>, key: String, key_state: Option<String>) {
    let mut enigo = match state.enigo.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    let direction = match key_state.as_deref() {
        Some("down") => Direction::Press,
        Some("up") => Direction::Release,
        _ => Direction::Click,
    };

    // Key mapping
    match key.as_str() {
        // Modifiers
        "Shift" => { let _ = enigo.key(Key::Shift, direction); },
        "Control" => { let _ = enigo.key(Key::Control, direction); },
        "Alt" => { let _ = enigo.key(Key::Alt, direction); },
        "Meta" => { let _ = enigo.key(Key::Meta, direction); },
        
        // Special Keys
        "Enter" => { let _ = enigo.key(Key::Return, direction); },
        "Backspace" => { let _ = enigo.key(Key::Backspace, direction); },
        "Tab" => { let _ = enigo.key(Key::Tab, direction); },
        "Space" => { let _ = enigo.key(Key::Space, direction); },
        "Escape" => { let _ = enigo.key(Key::Escape, direction); },
        "ArrowUp" => { let _ = enigo.key(Key::UpArrow, direction); },
        "ArrowDown" => { let _ = enigo.key(Key::DownArrow, direction); },
        "ArrowLeft" => { let _ = enigo.key(Key::LeftArrow, direction); },
        "ArrowRight" => { let _ = enigo.key(Key::RightArrow, direction); },
        "PageUp" => { let _ = enigo.key(Key::PageUp, direction); },
        "PageDown" => { let _ = enigo.key(Key::PageDown, direction); },
        "Home" => { let _ = enigo.key(Key::Home, direction); },
        "End" => { let _ = enigo.key(Key::End, direction); },
        "Delete" => { let _ = enigo.key(Key::Delete, direction); },
        "Insert" => { let _ = enigo.key(Key::Insert, direction); },
        "CapsLock" => { let _ = enigo.key(Key::CapsLock, direction); },
        "NumLock" => { let _ = enigo.key(Key::Numlock, direction); },

        // F-Keys
        "F1" => { let _ = enigo.key(Key::F1, direction); },
        "F2" => { let _ = enigo.key(Key::F2, direction); },
        "F3" => { let _ = enigo.key(Key::F3, direction); },
        "F4" => { let _ = enigo.key(Key::F4, direction); },
        "F5" => { let _ = enigo.key(Key::F5, direction); },
        "F6" => { let _ = enigo.key(Key::F6, direction); },
        "F7" => { let _ = enigo.key(Key::F7, direction); },
        "F8" => { let _ = enigo.key(Key::F8, direction); },
        "F9" => { let _ = enigo.key(Key::F9, direction); },
        "F10" => { let _ = enigo.key(Key::F10, direction); },
        "F11" => { let _ = enigo.key(Key::F11, direction); },
        "F12" => { let _ = enigo.key(Key::F12, direction); },

        k => {
            // Regular keys
            // 仅在按下 (Press/Click) 时触发输入，忽略释放 (Release) 事件
            // 否则会造成双倍输入 (按下一次，释放一次，导致输入两次)
            if direction == Direction::Press || direction == Direction::Click {
                for c in k.chars() {
                    // 针对 Shift+字母 或 大写锁定 的特殊处理：
                    // 浏览器发送的 key 已经是处理过修饰键的结果（如 "A"）。
                    // 此时如果不转为小写，Enigo::Unicode('A') 会尝试再次按下 Shift 键，
                    // 与我们手动同步的 Shift 状态发生冲突，导致输入无效或异常。
                    // 解决方案：如果收到大写字母，转为小写发送 (按下基础键 'a')，
                    // 依靠远端系统当前的修饰键状态 (Shift/CapsLock) 还原为大写 'A'。
                    let char_to_send = if c.is_ascii_uppercase() {
                        c.to_ascii_lowercase()
                    } else {
                        c
                    };
                    let _ = enigo.key(Key::Unicode(char_to_send), Direction::Click);
                }
            }
        }
    }
}

fn rdev_key_to_string(key: RKey) -> Option<String> {
    match key {
        RKey::Alt => Some("Alt".to_string()),
        RKey::AltGr => Some("AltGraph".to_string()),
        RKey::Tab => Some("Tab".to_string()),
        RKey::MetaLeft => Some("Meta".to_string()),
        RKey::MetaRight => Some("Meta".to_string()),
        RKey::Escape => Some("Escape".to_string()),
        // 增加对 Unknown 键码的防御性处理，防止 Alt 在某些焦点状态下被识别为 Unknown
        RKey::Unknown(18) | RKey::Unknown(164) | RKey::Unknown(165) => Some("Alt".to_string()),
        RKey::Unknown(9) => Some("Tab".to_string()),
        _ => None,
    }
}

fn callback(event: Event, tx: &Sender<KeyPayload>) -> Option<Event> {
    // 开启调试日志：在 Release 模式下配合 main.rs 的修改，可以看到控制台输出
    // if let EventType::KeyPress(k) = event.event_type {
    //    println!("Hook KeyPress: {:?} Intercepting: {}", k, IS_INTERCEPTING.load(Ordering::SeqCst));
    // }

    if !IS_INTERCEPTING.load(Ordering::SeqCst) {
        return Some(event);
    }

    match event.event_type {
        EventType::KeyPress(key) | EventType::KeyRelease(key) => {
            if let Some(key_str) = rdev_key_to_string(key) {
                // println!("Blocking target key: {:?}", key);

                // 关键优化：为了避免 Windows Hook 超时（LowLevelHooksTimeout，默认约300ms），
                // 我们必须立即返回 None 以阻止按键传递给系统。
                // 使用 Channel 发送事件，避免在 Hook 回调中创建线程，进一步降低延迟
                let is_press = matches!(event.event_type, EventType::KeyPress(_));
                let state = if is_press { "down" } else { "up" };
                
                let _ = tx.send(KeyPayload {
                    r#type: "keyboard".to_string(),
                    key: key_str,
                    key_state: state.to_string(),
                });

                return None; // Block input
            }
        }
        _ => {}
    }
    Some(event)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化 Enigo 实例并由 Tauri 管理状态
    // 这样避免每次调用 control_mouse 都重新初始化 Enigo，减少开销
    let enigo = Enigo::new(&Settings::default()).expect("Failed to initialize Enigo");

    tauri::Builder::default()
        .manage(AppState {
            enigo: Mutex::new(enigo),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let (tx, rx) = channel::<KeyPayload>();

            // 独立的事件发送线程
            std::thread::spawn(move || {
                while let Ok(payload) = rx.recv() {
                    let _ = handle.emit("control-event-local", payload);
                }
            });

            // Hook 线程
            std::thread::spawn(move || {
                if let Err(error) = grab(move |event| callback(event, &tx)) {
                    println!("Error: {:?}", error);
                }
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            control_mouse,
            control_keyboard,
            start_intercept,
            stop_intercept
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
