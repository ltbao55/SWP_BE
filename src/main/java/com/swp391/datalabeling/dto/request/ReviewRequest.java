package com.swp391.datalabeling.dto.request;

import com.swp391.datalabeling.enums.ReviewStatus;
import jakarta.validation.constraints.NotNull;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class ReviewRequest {

    @NotNull(message = "Status is required")
    private ReviewStatus status;

    private String comment;
    private String errorCategory;
}
