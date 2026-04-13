package com.swp391.datalabeling.dto.request;

import jakarta.validation.constraints.NotNull;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class AnnotationRequest {

    @NotNull(message = "Label class ID is required")
    private Long labelClassId;

    private String annotationData;
    private String annotationType;
}
