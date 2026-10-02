fn main() {
    println!("cargo:rerun-if-changed=native");
    println!("cargo:rerun-if-changed=upstream");
    let output = cmake::Config::new("native")
        .profile("Release")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        .build();
    println!("cargo:rustc-link-search=native={}/lib", output.display());
    println!("cargo:rustc-link-lib=static=explorer_avif_bridge");
    println!("cargo:rustc-link-lib=static=avif");
    if std::env::var("CARGO_CFG_TARGET_FAMILY").as_deref() == Ok("unix") {
        println!("cargo:rustc-link-lib=m");
        println!("cargo:rustc-link-lib=pthread");
    }
}
