//! Renderer generations within one concrete native window. No worker or OS
//! resources are created by advancing a document boundary.
use super::service::Owner;

pub(super) struct RendererScope {
    generation: u64,
    owner: Option<Owner>,
}

impl Default for RendererScope {
    fn default() -> Self {
        Self {
            generation: 0,
            owner: Some(Owner::default()),
        }
    }
}

impl RendererScope {
    pub fn session(&self) -> Option<String> {
        self.owner.as_ref().map(|_| self.generation.to_string())
    }

    pub fn owner(&self, session: &str) -> Option<Owner> {
        (self.generation.to_string() == session)
            .then(|| self.owner.clone())
            .flatten()
    }

    /// Closed native windows are terminal, including if a load callback arrives
    /// late. Exhausting generation IDs also fails closed rather than reusing one.
    pub fn advance(&mut self) -> Option<Owner> {
        let previous = self.close()?;
        if let Some(next) = self.generation.checked_add(1) {
            self.generation = next;
            self.owner = Some(Owner::default());
        }
        Some(previous)
    }

    pub fn close(&mut self) -> Option<Owner> {
        let previous = self.owner.take()?;
        previous.retire();
        Some(previous)
    }
}
