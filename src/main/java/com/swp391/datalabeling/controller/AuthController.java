package com.swp391.datalabeling.controller;

import com.swp391.datalabeling.dto.request.LoginRequest;
import com.swp391.datalabeling.dto.request.RegisterRequest;
import com.swp391.datalabeling.dto.response.ApiResponse;
import com.swp391.datalabeling.dto.response.JwtResponse;
import com.swp391.datalabeling.entity.User;
import com.swp391.datalabeling.service.AuthService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;

    @PostMapping("/register")
    public ResponseEntity<ApiResponse<User>> register(@Valid @RequestBody RegisterRequest request) {
        User user = authService.register(request);
        return ResponseEntity.ok(ApiResponse.success("User registered successfully", user));
    }

    @PostMapping("/login")
    public ResponseEntity<ApiResponse<JwtResponse>> login(@Valid @RequestBody LoginRequest request) {
        JwtResponse response = authService.login(request);
        return ResponseEntity.ok(ApiResponse.success("Login successful", response));
    }
}
