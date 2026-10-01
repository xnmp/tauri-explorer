//! Explicit worker ownership. The logical operation can settle its reservation
//! only after every worker capable of filesystem effects has released its clone.
use super::coordinator::Reservation;
#[cfg(test)]
use super::{coordinator::DurableOperation, model::OperationSpec};
use crate::error::AppError;
use std::sync::Arc;

pub(crate) struct MutationAdmission {
    reservation: Arc<Reservation>,
}

/// Keeps the owner available for an exact retry or ordinary settlement. Even
/// when publication failed, settlement never removes catalog evidence.
#[cfg(test)]
pub(crate) struct PromotionFailure {
    pub admission: MutationAdmission,
    pub error: AppError,
}

#[derive(Clone)]
pub(crate) struct MutationContext {
    _reservation: Arc<Reservation>,
}

impl MutationAdmission {
    pub(super) fn new(reservation: Reservation) -> Self {
        Self {
            reservation: Arc::new(reservation),
        }
    }

    pub(crate) fn paths(&self) -> impl Iterator<Item = &std::path::Path> {
        self.reservation.paths()
    }

    pub(crate) fn context(&self) -> MutationContext {
        MutationContext {
            _reservation: Arc::clone(&self.reservation),
        }
    }

    /// Run on the owned blocking worker before any artifact or source effects.
    /// Outstanding contexts prohibit changing the operation's ownership state.
    #[cfg(test)]
    pub(crate) fn promote(
        self,
        operation: OperationSpec,
    ) -> Result<DurableOperation, PromotionFailure> {
        let reservation = match Arc::try_unwrap(self.reservation) {
            Ok(reservation) => reservation,
            Err(reservation) => return Err(PromotionFailure {
                admission: Self { reservation },
                error: AppError::MutationUncertain("A filesystem worker still owns this reservation; durable promotion requires exclusive ownership".into()),
            }),
        };
        reservation
            .promote(operation)
            .map_err(|failure| PromotionFailure {
                admission: Self::new(failure.reservation),
                error: failure.error,
            })
    }

    pub(crate) fn finish(self) -> Result<(), AppError> {
        match Arc::try_unwrap(self.reservation) {
            Ok(reservation) => reservation.finish(),
            Err(_) => Err(AppError::MutationUncertain("A filesystem worker still owns this operation; recovery ownership remains until it exits".into())),
        }
    }
}

/// The actual blocking closure owns the context. Keeping it only in the async
/// caller would release ownership when that caller is dropped while the spawned
/// blocking task continues running.
#[cfg(test)]
pub(super) async fn run_blocking<T, F>(context: MutationContext, work: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    crate::files::worker::run_blocking_owned(context, work).await
}

#[cfg(test)]
#[path = "../../../test_support/recovery_context.rs"]
mod tests;
