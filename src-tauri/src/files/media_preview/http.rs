//! Standard HTTP streaming with per-connection retirement and backpressure.
use super::{
    range::{byte_plan, BytePlan},
    service::{read_chunk, Lease, Service},
};
use crate::renderer_owner::Owner;
use bytes::Bytes;
use futures_util::{stream, TryStreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Empty, StreamBody};
use hyper::{
    body::{Frame, Incoming},
    header, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{convert::Infallible, io, net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{watch, Semaphore},
};

type Body = UnsyncBoxBody<Bytes, io::Error>;
pub(super) struct Server {
    pub service: Arc<Service>,
    pub address: SocketAddr,
    pub stop: Owner,
}
fn empty(status: StatusCode) -> Response<Body> {
    let body = Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed_unsync();
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    response
}
pub(super) async fn start(service: Arc<Service>) -> io::Result<Arc<Server>> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let server = Arc::new(Server {
        service,
        address: listener.local_addr()?,
        stop: Owner::default(),
    });
    let running = server.clone();
    tokio::spawn(async move {
        let connections = Arc::new(Semaphore::new(64));
        loop {
            let permit = tokio::select! { _=running.stop.retired()=>break,
            permit=connections.clone().acquire_owned()=>match permit {Ok(permit)=>permit,Err(_)=>break} };
            let socket = tokio::select! { _=running.stop.retired()=>break,
            accepted=listener.accept()=>match accepted {Ok((socket,_))=>socket,Err(_)=>break} };
            let server = running.clone();
            tokio::spawn(async move {
                let _permit = permit;
                #[cfg(feature = "e2e-hooks")]
                let _connection = super::metrics::Connection::entered();
                let (retirement, mut observed) = watch::channel::<Option<Arc<Lease>>>(None);
                let core = server.clone();
                let service = hyper::service::service_fn(move |request| {
                    let core = core.clone();
                    let retirement = retirement.clone();
                    async move { Ok::<_, Infallible>(respond(&core, request, retirement).await) }
                });
                let mut builder = hyper::server::conn::http1::Builder::new();
                builder
                    .keep_alive(false)
                    .max_buf_size(16 * 1024)
                    .max_headers(32)
                    .timer(TokioTimer::new())
                    .header_read_timeout(Duration::from_secs(5));
                let connection = builder.serve_connection(TokioIo::new(socket), service);
                let retired = async move {
                    loop {
                        let lease = { observed.borrow().clone() };
                        if let Some(lease) = lease {
                            lease.retired().await;
                            return;
                        }
                        // Unknown routes still finish their ordinary error response.
                        if observed.changed().await.is_err() {
                            std::future::pending::<()>().await;
                        }
                    }
                };
                tokio::select! { _=connection=>{},_=retired=>{},_=server.stop.retired()=>{} }
            });
        }
    });
    Ok(server)
}

async fn respond(
    server: &Server,
    request: Request<Incoming>,
    retirement: watch::Sender<Option<Arc<Lease>>>,
) -> Response<Body> {
    let headers = request.headers();
    let host = server.address.to_string();
    if headers.get_all(header::HOST).iter().count() != 1
        || headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            != Some(host.as_str())
        || request
            .uri()
            .authority()
            .is_some_and(|authority| authority.as_str() != host)
        || request.uri().query().is_some()
        || headers.contains_key(header::TRANSFER_ENCODING)
        || headers
            .get(header::CONTENT_LENGTH)
            .is_some_and(|value| value.as_bytes() != b"0")
    {
        return empty(StatusCode::BAD_REQUEST);
    }
    let head = request.method() == hyper::Method::HEAD;
    if !head && request.method() != hyper::Method::GET {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some(token) = request
        .uri()
        .path()
        .strip_prefix("/media/")
        .filter(|token| token.len() == 48 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
    else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Some(lease) = server.service.lookup(token) else {
        return empty(StatusCode::NOT_FOUND);
    };
    // Retirement aborts a stalled socket even when Hyper no longer polls its body.
    let _ = retirement.send(Some(lease.clone()));
    let Some(media) = lease.file() else {
        return empty(StatusCode::NOT_FOUND);
    };
    let range = if head
        || headers.contains_key(header::IF_RANGE)
        || headers.get_all(header::RANGE).iter().count() > 1
    {
        None
    } else {
        headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
    };
    let plan = byte_plan(range, media.size);
    let (start, length, status) = match plan {
        BytePlan::Full => (0, media.size, StatusCode::OK),
        BytePlan::Partial { start, length } => (start, length, StatusCode::PARTIAL_CONTENT),
        BytePlan::Unsatisfiable => {
            let mut response = empty(StatusCode::RANGE_NOT_SATISFIABLE);
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{}", media.size).parse().unwrap(),
            );
            return response;
        }
    };
    let mut response = empty(status);
    response.headers_mut().insert(
        header::ACCEPT_RANGES,
        header::HeaderValue::from_static("bytes"),
    );
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static(media.mime),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, length.to_string().parse().unwrap());
    if status == StatusCode::PARTIAL_CONTENT {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, start + length - 1, media.size)
                .parse()
                .unwrap(),
        );
    }
    if head || length == 0 {
        return response;
    }
    let Ok(permit) = server.service.streams.clone().try_acquire_owned() else {
        return empty(StatusCode::SERVICE_UNAVAILABLE);
    };
    let active = lease.clone();
    let opened = tokio::task::spawn_blocking(move || {
        if !active.active() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Video preview was released",
            ));
        }
        media.open_stream(permit)
    });
    let file = tokio::select! {_=lease.retired()=>return empty(StatusCode::GONE),
    opened=opened=>match opened {Ok(Ok(file))=>file,_=>return empty(StatusCode::CONFLICT)} };
    let chunks=stream::try_unfold((file,start,length,lease),|(file,offset,remaining,lease)| async move {
        if remaining==0 {return Ok::<_,io::Error>(None);}
        let reading=file.clone();
        let read=tokio::task::spawn_blocking(move || read_chunk(&reading.file,offset,remaining));
        let bytes=tokio::select! {_=lease.retired()=>return Err(io::Error::new(io::ErrorKind::Interrupted,"Video preview was released")),
            read=read=>read.map_err(io::Error::other)?? };
        let count=bytes.len() as u64;
        Ok(Some((bytes,(file,offset+count,remaining-count,lease))))
    }).map_ok(Frame::data);
    *response.body_mut() = StreamBody::new(chunks).boxed_unsync();
    response
}
