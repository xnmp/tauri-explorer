//! Bounded completion diagnostics, independent of failure and history retention.
const MAX_MESSAGES: usize = 32;
const MAX_BYTES: usize = 16 * 1024;
const OMITTED: &str = "Additional warnings were omitted";

pub(crate) fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| payload.downcast_ref::<&str>().copied())
        .unwrap_or("Background worker panicked")
        .chars()
        .take(4096)
        .collect()
}

#[derive(Default)]
pub(crate) struct Warnings {
    messages: Vec<String>,
    bytes: usize,
    omitted: bool,
}

impl Warnings {
    pub(crate) fn push(&mut self, message: impl AsRef<str>) {
        let message = message.as_ref();
        if self.omitted || message.is_empty() || self.messages.iter().any(|entry| entry == message)
        {
            return;
        }
        // Reserve separators as well as the omission marker so callers can
        // join the bounded messages with newlines without exceeding the cap.
        let available = MAX_BYTES - (MAX_MESSAGES - 1) - OMITTED.len() - self.bytes;
        if self.messages.len() >= MAX_MESSAGES - 1 || message.len() > available {
            if self.messages.len() < MAX_MESSAGES - 1 && available > 0 {
                let mut end = available;
                while !message.is_char_boundary(end) {
                    end -= 1;
                }
                if end > 0 {
                    self.messages.push(message[..end].to_owned());
                }
            }
            self.messages.push(OMITTED.to_owned());
            self.omitted = true;
            return;
        }
        self.bytes += message.len();
        // Copy only accepted bytes: an oversized caller allocation is not retained.
        self.messages.push(message.to_owned());
    }

    pub(crate) fn extend(&mut self, messages: impl IntoIterator<Item = String>) {
        for message in messages {
            self.push(message);
            if self.omitted {
                break;
            }
        }
    }

    pub(crate) fn into_vec(self) -> Vec<String> {
        self.messages
    }
}

impl FromIterator<String> for Warnings {
    fn from_iter<T: IntoIterator<Item = String>>(iter: T) -> Self {
        let mut warnings = Self::default();
        warnings.extend(iter);
        warnings
    }
}

#[cfg(test)]
#[path = "../test_support/diagnostics.rs"]
mod tests;
